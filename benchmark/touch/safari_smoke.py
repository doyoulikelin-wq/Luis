"""iOS Simulator Safari touch-liveness probes via safaridriver. Uses the Python standard library."""
import argparse
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import threading
import json
from pathlib import Path
import socket
import subprocess
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode
from urllib.request import Request, urlopen


def request(method, url, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = Request(url, data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urlopen(req, timeout=25) as response:
            return json.load(response)["value"]
    except HTTPError as exc:
        raise RuntimeError(exc.read().decode()) from exc


def wait_for(test, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if test():
                return
        except (RuntimeError, URLError):
            pass
        time.sleep(.12)
    raise RuntimeError("Expected browser condition did not arrive")


# The driver issues *untrusted* PointerEvents in application-level cases. The
# image sample is taken on a rendered frame, independently of the status label.
INSTALL = """
const s=document.querySelector('#window-surface');
const trace=window.__iosLiveness={life:[],events:[],latest:null};
for (const type of ['visibilitychange','pagehide','pageshow','blur','focus']) {
  (type==='visibilitychange'?document:window).addEventListener(type,e=>
    trace.life.push({type,hidden:document.hidden,persisted:e.persisted===true}));
}
for (const type of ['pointerdown','pointermove','pointerup','pointercancel','lostpointercapture']) {
  window.addEventListener(type,e=>trace.events.push({type,id:e.pointerId,trusted:e.isTrusted}),true);
}
trace.send=(type,id,u)=>{const r=s.getBoundingClientRect();
  s.dispatchEvent(new PointerEvent(type,{pointerId:id,isPrimary:true,pointerType:'touch',button:0,
    buttons:type==='pointerup'||type==='pointercancel'?0:1,bubbles:true,cancelable:true,
    clientX:r.left+u*r.width,clientY:r.top+.57*r.height}));};
trace.wait=ms=>new Promise(r=>setTimeout(r,ms));
trace.mode=()=>s.dataset.gesture;
const scratch=document.createElement('canvas');scratch.width=200;scratch.height=160;
const ctx=scratch.getContext('2d',{willReadFrequently:true});
trace.measure=()=>new Promise(resolve=>{
  const listener=e=>{
    if(e.detail.blink>.08)return;
    document.removeEventListener('luis:frame',listener,true);
    ctx.drawImage(e.target,0,0,200,160);
    const pixels=ctx.getImageData(0,0,200,160).data;
    const iris=(x0,x1)=>{let sum=0,n=0;
      for(let y=92;y<138;y++)for(let x=x0;x<x1;x++){
        const i=4*(200*y+x),r=pixels[i],g=pixels[i+1],b=pixels[i+2];
        if(b>145&&g>110&&g-r>42&&b-r>70){sum+=x;n++;}}
      return n>=4?sum/n:null;};
    resolve([iris(52,100),iris(105,148)]);
  };
  document.addEventListener('luis:frame',listener,true);
  setTimeout(()=>{document.removeEventListener('luis:frame',listener,true);resolve([null,null]);},900);
});
document.addEventListener('luis:frame',e=>trace.latest=e.detail,true);
"""

PROBE = """
q.send('pointerdown',91,.16); await q.wait(510);
const left={mode:q.mode(),pixel:await q.measure(),target:q.latest?.targetX};
q.send('pointermove',91,.85); await q.wait(280);
const right={mode:q.mode(),pixel:await q.measure(),target:q.latest?.targetX};
q.send('pointerup',91,.85); await q.wait(430);
const delta=right.pixel.map((x,i)=>x===null||left.pixel[i]===null?null:x-left.pixel[i]);
return {left,right,delta,idle:q.mode()==='idle',centered:Math.abs(q.latest?.eyeX)<.15&&Math.abs(q.latest?.headX)<.15,
  inputTrusted:false};
"""


def run(args, driver_url):
    caps = {"platformName":"iOS","browserName":"Safari","safari:useSimulator":True,"safari:deviceUDID":args.udid}
    creation = request("POST", driver_url+"/session", {"capabilities":{"alwaysMatch":caps}})
    session = driver_url+"/session/"+creation["sessionId"]
    def op(method, path, data=None):
        return request(method, session+path, data)
    def js(script):
        return op("POST","/execute/sync",{"script":script,"args":[]})
    def sequence(script):
        body = "const done=arguments[arguments.length-1], q=window.__iosLiveness;" + \
            "(async()=>{"+script+"})().then(done,e=>done({exception:String(e)}));"
        result = op("POST","/execute/async",{"script":body,"args":[]})
        if isinstance(result,dict) and "exception" in result:
            raise RuntimeError(result["exception"])
        return result
    def ready():
        wait_for(lambda: js("return Boolean(document.querySelector('#window-surface') && !['loading','error'].includes(document.querySelector('#window-surface').dataset.gesture))"))
    def reset():
        op("POST","/url",{"url":"about:blank"})
        op("POST","/url",{"url":args.url})
        ready()
        js(INSTALL)
    def past_drag():
        mode = sequence("q.send('pointerdown',41,.21);await q.wait(520);q.send('pointermove',41,.79);await q.wait(110);return q.mode();")
        if mode!="drag":
            raise RuntimeError("Drag precondition failed: "+str(mode))
    def probe_ok(result):
        return (result["left"]["mode"]=="hold" and result["right"]["mode"]=="drag" and result["idle"]
                and result["centered"] and all(x is not None and x>1 for x in result["delta"]))
    public_environment = {key:creation["capabilities"].get(key) for key in (
        "browserName","browserVersion","platformName","safari:useSimulator","safari:deviceName",
        "safari:platformVersion","safari:platformBuildVersion")}
    report={"schema":"luis.ios-simulator-touch.v1","url":args.url,"capabilities":public_environment,"results":[]}
    def case(name, evidence, fn):
        row={"id":name,"input":evidence}
        report["results"].append(row)
        try:
            reset()
            expected, details = fn()
            row.update(details)
            row["probe"]=sequence(PROBE)
            row["status"]="unverified" if expected is None else ("pass" if expected and probe_ok(row["probe"]) else "fail")
        except (RuntimeError,URLError,TimeoutError,subprocess.SubprocessError) as e:
            row.update(status="unverified",reason=str(e)[:450])
        args.out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
        print(name,row["status"],flush=True)
    try:
        info=creation["capabilities"]
        if not info.get("safari:useSimulator") or info.get("safari:deviceUDID")!=args.udid:
            raise RuntimeError("Session did not bind to the requested simulator")
        # Calibrate native WebDriver delivery on a neutral document before interpreting
        # any missing touch from the application as a platform defect.
        op("POST","/url",{"url":"about:blank"})
        js("document.body.style.cssText='position:fixed;inset:0;touch-action:none'; window.nativeEvents=[]; for(const t of ['pointerdown','pointerup','pointercancel']) window.addEventListener(t,e=>nativeEvents.push({type:t,trusted:e.isTrusted,pointerType:e.pointerType}));")
        actions=[{"type":"pointerMove","origin":"viewport","x":110,"y":150,"duration":0},
                 {"type":"pointerDown","button":0},{"type":"pause","duration":90},{"type":"pointerUp","button":0}]
        try:
            op("POST","/actions",{"actions":[{"id":"nativeFinger","type":"pointer","parameters":{"pointerType":"touch"},"actions":actions}]})
            time.sleep(.25)
            events=js("return nativeEvents")
            delivered={e["type"] for e in events if e["trusted"] and e["pointerType"]=="touch"}
            report["nativeDriverCalibration"]={"events":events,"complete":{"pointerdown","pointerup"}<=delivered}
        except (RuntimeError,URLError) as e:
            report["nativeDriverCalibration"]={"complete":False,"reason":str(e)[:450]}
        if report["nativeDriverCalibration"]["complete"]:
            def native_tap():
                location=js("const r=document.querySelector('#window-surface').getBoundingClientRect();return {x:Math.round(r.left+r.width*.3),y:Math.round(r.top+r.height*.5)};")
                tap=[dict(actions[0],**location),*actions[1:]]
                op("POST","/actions",{"actions":[{"id":"nativeFinger","type":"pointer","parameters":{"pointerType":"touch"},"actions":tap}]})
                ev=js("return __iosLiveness.events")
                phases={e["type"] for e in ev if e["trusted"]}
                return {"pointerdown","pointerup"}<=phases,{"events":ev}
            case("trusted-driver-terminal","WebDriver touch then application-level recovery probe",native_tap)

        for phase in ("press","hold","drag"):
            def cancel(phase=phase):
                setup={"press":"","hold":"await q.wait(495);","drag":"await q.wait(495);q.send('pointermove',41,.78);"}[phase]
                ret=sequence("q.send('pointerdown',41,.20);"+setup+"const before=q.mode();q.send('pointercancel',41,.78);return [before,q.mode()];")
                return ret==[phase,"idle"],{"beforeAndAfterCancel":ret}
            case("cancel-"+phase,"application PointerEvent replay",cancel)
        def lost():
            past_drag()
            ret=sequence("q.send('lostpointercapture',41,.78);return q.mode();")
            return ret=="idle",{"afterCaptureLoss":ret}
        case("lost-capture","application PointerEvent replay",lost)

        def missing():
            past_drag()
            return True,{"fault":"omit up, cancel and capture loss before fresh primary down","staleMode":js("return __iosLiveness.mode()")}
        case("missing-terminals","fault-injected missing application terminals",missing)

        def reload_page():
            past_drag()
            op("POST","/refresh",{})
            ready()
            old_present=js("return Boolean(window.__iosLiveness)")
            mode=js("return document.querySelector('#window-surface').dataset.gesture")
            js(INSTALL)
            return mode=="idle" and not old_present,{"sameDocument":old_present,"mode":mode}
        case("actual-reload","injected drag and actual Safari refresh",reload_page)
        def history():
            past_drag()
            op("POST","/url",{"url":"about:blank"})
            op("POST","/back",{})
            ready()
            prior=js("return window.__iosLiveness?.life || null")
            mode=js("return document.querySelector('#window-surface').dataset.gesture")
            if prior is None:
                js(INSTALL)
            restored=bool(prior and any(e["type"]=="pageshow" and e["persisted"] for e in prior))
            return mode=="idle",{"mode":mode,"persisted":restored,"events":prior}
        case("actual-history-back","injected drag and actual Safari navigation/back",history)
        def tab_switch():
            past_drag()
            original=op("GET","/window")
            other=op("POST","/window/new",{"type":"tab"})["handle"]
            try:
                op("POST","/window",{"handle":other})
                time.sleep(.55)
            finally:
                op("POST","/window",{"handle":original})
            ready()
            events=js("return window.__iosLiveness?.life || []")
            mode=js("return document.querySelector('#window-surface').dataset.gesture")
            hidden=any(e["type"]=="visibilitychange" and e["hidden"] for e in events)
            shown=any(e["type"]=="visibilitychange" and not e["hidden"] for e in events)
            return (mode=="idle" if hidden and shown else None),{"lifecycle":events,"mode":mode}
        case("actual-tab-switch","injected drag and real Safari tab switch",tab_switch)

        return report
    finally:
        try:
            op("DELETE","")
        except RuntimeError as exc:
            if "invalid session id" not in str(exc):
                raise


def simulator_background(udid):
    # Safari WebDriver may invalidate its own session on backgrounding. Open a
    # dedicated local tab, collect callbacks at a loopback server, then switch apps.
    root=Path(__file__).resolve().parents[2]/"platform/web/window"
    results={}
    ready=threading.Event()
    completed=threading.Event()
    script = """
(async()=>{
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const post=(path,data)=>fetch(path,{method:'POST',body:JSON.stringify(data)});
  try {
    for(let n=0;n<100 && document.querySelector('#window-surface')?.dataset.gesture!=='idle';n++)await sleep(100);
""" + INSTALL + """
    const q=window.__iosLiveness;
    q.send('pointerdown',41,.21);await q.wait(510);q.send('pointermove',41,.79);await q.wait(110);
    if(q.mode()!=='drag')throw Error('Cannot seed a drag');
    let started=false;
    document.addEventListener('visibilitychange', async()=>{
      if(document.hidden){started=true; return;}
      if(!started)return;
      const mode=q.mode();
      const probe=await(async()=>{""" + PROBE + """})();
      await post('/report',{mode,lifecycle:q.life,probe});
    });
    await post('/armed',{mode:q.mode()});
  }catch(e){await post('/report',{error:String(e)});}
})();
"""
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self,*args,**kwargs):
            super().__init__(*args,directory=str(root),**kwargs)
        def log_message(self,*args):
            pass
        def do_GET(self):
            if urlsplit(self.path).path=='/':
                content=(root/'index.html').read_bytes().replace(b'</body>',b'<script defer src="./_touch_probe.js"></script></body>')
                mime='text/html; charset=utf-8'
            elif self.path=='/_touch_probe.js':
                content=script.encode(); mime='application/javascript'
            else:
                return super().do_GET()
            self.send_response(200);self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(content)));self.end_headers()
            self.wfile.write(content)
        def do_POST(self):
            if self.path not in ('/armed','/report'):
                return self.send_error(404)
            results[self.path]=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            self.send_response(204);self.end_headers()
            (ready if self.path=='/armed' else completed).set()
    row={'id':'actual-app-switch','input':'local instrumented tab, injected drag and actual Simulator Settings/Safari switch',
         'source':'platform/web/window','entry':'checkout HTML with one probe script appended',
         'assetHashes':{name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in ('main.js','interaction.js','actor.js')}}
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    def sim(*command):
        subprocess.run(['xcrun','simctl',command[0],udid,*command[1:]],check=True,capture_output=True,timeout=12)
    try:
        sim('openurl',f'http://127.0.0.1:{server.server_port}/?inspect=1')
        if not ready.wait(13): raise RuntimeError('No pre-switch drag receipt')
        sim('launch','com.apple.Preferences')
        time.sleep(1.25)
        sim('launch','com.apple.mobilesafari')
        if not completed.wait(9): raise RuntimeError('Tab did not report returning to visible')
        result=results['/report']
        row.update(result)
        if 'error' in result: raise RuntimeError(result['error'])
        probe=result['probe']
        seen={e['hidden'] for e in result['lifecycle'] if e['type']=='visibilitychange'}
        if seen!={True, False}:
            raise RuntimeError('Missing independent hidden/visible trace')
        ok=(result['mode']=='idle' and probe['left']['mode']=='hold' and probe['right']['mode']=='drag'
            and probe['idle'] and probe['centered'] and all(x is not None and x>1 for x in probe['delta']))
        row['status']='pass' if ok else 'fail'
    except (RuntimeError,subprocess.SubprocessError) as e:
        row.update(status='unverified',reason=str(e))
    finally:
        server.shutdown();server.server_close()
    print(row['id'],row['status'],flush=True)
    return row


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--udid",required=True,help="UDID of an already booted iOS Simulator")
    parser.add_argument("--url",default="http://127.0.0.1:8774/platform/web/window/")
    parser.add_argument("--out",type=Path,required=True)
    parser.add_argument("--background",action="store_true",help="Briefly switch this simulator to Settings and back")
    args=parser.parse_args()
    parts=urlsplit(args.url)
    query=dict(parse_qsl(parts.query));query["inspect"]="1"
    args.url=urlunsplit(parts._replace(query=urlencode(query)))
    with socket.socket() as s:
        s.bind(("127.0.0.1",0));port=s.getsockname()[1]
    url=f"http://127.0.0.1:{port}"
    driver=subprocess.Popen(["safaridriver","--port",str(port)])
    try:
        wait_for(lambda:request("GET",url+"/status") is not None)
        report=run(args,url)
        if args.background:
            report["results"].append(simulator_background(args.udid))
        args.out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
    finally:
        driver.terminate()
        driver.wait(timeout=6)
    return int(any(r["status"]!="pass" for r in report["results"]))


if __name__=="__main__":
    raise SystemExit(main())
