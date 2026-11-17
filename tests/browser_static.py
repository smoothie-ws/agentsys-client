"""Independent static-client browser checks: no backend package or process."""
from pathlib import Path
import json, os, queue, re, subprocess, threading
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parents[1]
proc=subprocess.Popen(['node',str(root/'bin/agentsys-client.js'),'serve','--port','0'],cwd=root,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
lines=queue.Queue()
def read():
    for line in proc.stdout: lines.put(line)
threading.Thread(target=read,daemon=True).start()
config=root/'dist/client/config.json'; original=config.read_bytes()
try:
    origin=None
    for _ in range(40):
        line=lines.get(timeout=5)
        match=re.search(r'Listening on (http://\S+)',line)
        if match: origin=match[1]; break
    assert origin
    with sync_playwright() as p:
        browser=getattr(p,os.environ.get('AGENTSYS_BROWSER','chromium')).launch()
        context=browser.new_context()
        context.add_init_script("""
          if (window.top === window) {
          localStorage.setItem('agentsys-environments', JSON.stringify([{id:'old',name:'Old',url:'https://old.invalid'}]));
          localStorage.setItem('agentsys-client-plugins', '[{"id":"old","source":"exports.activate = () => {};"}]');
          localStorage.setItem('agentsys-ui-store', '{"old-setting":true}');
          sessionStorage.setItem('agentsys-token:old', 'old-token');
          }
        """)
        page=context.new_page(); errors=[]
        page.on('pageerror',lambda e: errors.append(str(e)))
        page.goto(origin)
        page.wait_for_function("typeof Environment !== 'undefined' && Environment.status().status === 'disconnected'")
        assert page.evaluate('Environment.list().length')==0
        assert page.evaluate('PluginStore.list().length')==0
        assert page.evaluate("store.get('old-setting')") is None
        assert page.evaluate("JSON.parse(localStorage.getItem('agentsys-environments'))[0].id")=='old'
        assert page.evaluate("sessionStorage.getItem('agentsys-token:old')")=='old-token'
        assert page.evaluate("localStorage.getItem('agentsys-client-plugins')") is not None
        assert page.evaluate("localStorage.getItem('agentsys-ui-store')")=='{"old-setting":true}'
        page.evaluate('() => { installPluginDialog(); }')
        page.locator('#modal input[name=id]').fill('first-plugin')
        page.locator('#modal input[name=title]').fill('First plugin')
        assert page.locator('#modal input[name=version]').input_value()=='0.1.0'
        page.locator('#modal textarea[name=source]').fill('exports.activate = api => { api.commands.register("hello", () => "ready"); };')
        page.locator('#modal button[value=ok]').click()
        page.locator('#modal').wait_for(state='hidden')
        page.wait_for_function("Extensions.apiOf('first-plugin') !== null")
        assert page.evaluate("Extensions.execute('first-plugin:hello')")=='ready'
        assert page.evaluate("PluginStore.get('first-plugin').api")==1
        page.evaluate("Extensions.uninstall('first-plugin')")
        assert page.locator('#view').inner_text().strip()
        state=page.evaluate("async () => { const env=Environment.save({name:'Unavailable server',url:'http://127.0.0.1:1'}); await Environment.setActive(env.id); return Environment.status(); }")
        assert state['status']=='disconnected' and state['detail']
        assert not errors, errors
        config.write_text(json.dumps({'defaultServerURL':'http://127.0.0.1:1'}))
        configured=browser.new_page(); configured.goto(origin)
        configured.wait_for_function("typeof Environment !== 'undefined' && Environment.list().length === 1")
        assert configured.evaluate('Environment.list()[0].url')=='http://127.0.0.1:1'
        browser.close()
    print('PASS independent static client, disconnected transport and runtime config')
finally:
    config.write_bytes(original)
    proc.terminate(); proc.wait(timeout=10)
