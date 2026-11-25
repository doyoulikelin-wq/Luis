const KEY = "luis.preview.instances.v1";
const ASSET = "builtin:upper-body.v1";
const PERSONAS = {
  calm: { label: "沉静", greet: "你好。今天想从哪件事聊起？", tired: "那就坐一会儿。我听着。", action: "nod" },
  lively: { label: "开朗", greet: "嗨！今天有什么小事想跟我分享？", tired: "辛苦啦！想吐槽两句，还是一起放空一下？", action: "wave" }
};

function boundedText(value, limit) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= limit;
}

export function parseCharacter(value) {
  if (!value || value.schema !== "luis.character.v1" || value.asset !== ASSET ||
      Object.keys(value).some(k => !["schema","asset","name","persona","accent"].includes(k)) ||
      !boundedText(value.name, 32) || typeof value.persona !== "string" || !Object.hasOwn(PERSONAS, value.persona) ||
      typeof value.accent !== "string" ||
      !/^#[0-9a-f]{6}$/i.test(value.accent)) {
    throw new Error("需要兼容的 luis.character.v1 角色包，含名称、性格、配色和内置模型。");
  }
  return {schema: value.schema, asset: ASSET, name: value.name.trim(),
          persona: value.persona, accent: value.accent.toLowerCase()};
}

function initialInstance() {
  return { id: crypto.randomUUID(), pack: {schema: "luis.character.v1", asset: ASSET, name: "小砚",
          persona: "calm", accent: "#42645b"}, remember: false, nickname: "" };
}

function readShelf() {
  const saved = localStorage.getItem(KEY);
  if (saved === null) {
    const item = initialInstance();
    return {active: item.id, items: [item]};
  }
  const data = JSON.parse(saved);
  if (!Array.isArray(data.items) || !data.items.length) throw new Error("本机记录格式有误");
  const seen = new Set();
  const items = data.items.map(item => {
    if (!item || !boundedText(item.id, 80) || seen.has(item.id) || typeof item.remember !== "boolean" ||
        typeof item.nickname !== "string" || item.nickname.length > 32) throw new Error("本机实例格式有误");
    seen.add(item.id);
    return {id: item.id, pack: parseCharacter(item.pack), remember: item.remember,
            nickname: item.remember ? item.nickname : ""};
  });
  if (!seen.has(data.active)) throw new Error("无法找到当前角色");
  return {active: data.active, items};
}

export function mountCompanion(container, {playAction, setAccent}) {
  let shelf, initialNotice = "", canSave = true;
  try {
    shelf = readShelf();
  } catch {
    const item = initialInstance();
    shelf = {active: item.id, items: [item]};
    canSave = false;
    initialNotice = "本机存储不可用或旧记录无法读取，本次在临时会话中试用。";
  }
  const element = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const label = (title, control) => {
    const row = element("label"); row.append(element("span", title), control); return row;
  };
  const button = (name, action) => {
    const b = element("button",name); b.type = "button"; b.addEventListener("click",action); return b;
  };
  const group = (...children) => {
    const row = element("div"); row.className="cp-actions"; row.append(...children); return row;
  };
  const active = () => shelf.items.find(i => i.id === shelf.active);
  const select = element("select"), name = element("input"), persona = element("select"), color = element("input");
  name.maxLength = 32; color.type = "color";
  for (const [key, def] of Object.entries(PERSONAS)) persona.add(new Option(def.label, key));
  const remember = element("input"), nick = element("input");
  remember.type="checkbox"; nick.maxLength=32; nick.placeholder="你希望被怎样称呼";
  const answer = element("p"), status = element("p");
  status.setAttribute("role","status"); answer.setAttribute("aria-live","polite");
  answer.className="cp-answer"; status.className="cp-note";
  const tell = text => { status.textContent=text; };
  const save = (message) => {
    if (canSave) {
      try { localStorage.setItem(KEY,JSON.stringify(shelf)); tell(message); return; }
      catch { canSave=false; }
    }
    tell(message + " 仅本次会话有效，未写入本机。");
  };
  const sync = () => {
    const item = active();
    select.replaceChildren(...shelf.items.map((i,k)=>new Option(i.pack.name+" · "+(k+1),i.id)));
    select.value=item.id; name.value=item.pack.name; persona.value=item.pack.persona; color.value=item.pack.accent;
    remember.checked=item.remember; nick.value=item.nickname; nick.disabled=!item.remember;
    setAccent(item.pack.accent); answer.textContent="";
  };
  select.onchange=()=>{ shelf.active=select.value; sync(); save("已切换角色实例。"); };
  const update = () => {
    const item=active();
    try { item.pack=parseCharacter({...item.pack,name:name.value,persona:persona.value,accent:color.value}); }
    catch(error){ tell(error.message); return false; }
    setAccent(item.pack.accent);
    select.selectedOptions[0].textContent=item.pack.name+" · "+(select.selectedIndex+1);
    save("已应用角色设定。"); return true;
  };
  remember.onchange=()=>{const i=active();i.remember=remember.checked;if(!i.remember)i.nickname="";
    nick.value=i.nickname;nick.disabled=!i.remember;answer.textContent="";save(i.remember?"已允许本机保存称呼。":"已关闭记忆并清除本实例称呼。");};
  function talk(action){
    const i=active(),p=PERSONAS[i.pack.persona];
    const text = action==="recall" ? (i.nickname ? "你希望我叫你"+i.nickname+"。" : "我还没有记下你的称呼。") : p[action];
    answer.textContent=i.pack.name+"　"+text; playAction(action==="recall"?"nod":p.action);
  }
  function exportPack(){
    if (!update()) return;
    const url=URL.createObjectURL(new Blob([JSON.stringify(active().pack,null,2)],{type:"application/json"}));
    const a=element("a");a.href=url;a.download="character.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    tell("已导出公开角色设定。");
  }
  const input=element("input");input.type="file";input.accept=".json,application/json";input.hidden=true;
  input.onchange=async()=>{
    const file=input.files?.[0];input.value="";if(!file)return;
    try {
      if(file.size>65536)throw new Error("角色包超过 64 KiB。");
      const pack=parseCharacter(JSON.parse(await file.text()));
      const item={...initialInstance(),pack};
      shelf.items.push(item);shelf.active=item.id;sync();save("已创建独立实例，称呼记忆为空。");
    }catch(error){tell("导入失败。"+error.message);}
  };
  const root=element("section");root.className="cp-panel";
  root.append(label("当前实例",select),group(label("角色名称",name),label("服装色",color)),
    label("回应风格",persona),group(button("应用设定",update),button("导入角色包",()=>input.click()),button("导出角色包",exportPack)),input,
    element("h3","场景试演"),element("p","固定台词演示语气与动作。"),group(button("打招呼",()=>talk("greet")),button("我有点累",()=>talk("tired")),button("问我的称呼",()=>talk("recall"))),answer,
    element("h3","本机记忆"),label("允许保存称呼，关闭时清除",remember),label("称呼",nick),
    group(button("记住称呼",()=>{if(!active().remember){tell("请先开启本机记忆。");return;}if(!boundedText(nick.value,32)){tell("请输入 1–32 个字符。");return;}
      active().nickname=nick.value.trim();save("本实例已记住新称呼。");}),
    button("忘记称呼",()=>{active().nickname="";nick.value="";answer.textContent="";save("已清除本实例称呼。");})),status);
  container.replaceChildren(root);sync();tell(initialNotice);
}
