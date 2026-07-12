"""Drive a real lesson over the WebSocket and confirm real Rime `marlu` audio
flows. Stops after the first spoken beat to keep it cheap."""
import asyncio, json, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
import urllib.request
import websockets

API = 'http://localhost:8000/api'


def login():
    req = urllib.request.Request(f'{API}/auth/login/',
        data=json.dumps({'email': 'rnd@test.com', 'password': 'testpass12345'}).encode(),
        headers={'Content-Type': 'application/json'}, method='POST')
    return json.load(urllib.request.urlopen(req))['access']


async def main():
    token = login()
    async with websockets.connect(f'ws://localhost:8000/ws/lesson/?token={token}') as ws:
        print('connected'); assert json.loads(await ws.recv())['type'] == 'ready'
        await ws.send(json.dumps({'type': 'startLesson', 'topic': 'what a fraction is'}))
        audio_bytes = 0
        while True:
            m = await asyncio.wait_for(ws.recv(), timeout=90)
            if isinstance(m, (bytes, bytearray)):
                audio_bytes += len(m); continue
            msg = json.loads(m); t = msg.get('type')
            if t == 'thinking': print('  <- thinking…')
            elif t == 'lessonStarted': print(f"  <- lessonStarted: {msg['title']!r} | sections={msg['sections']}")
            elif t == 'loadShapes': print(f"  <- loadShapes ({len(msg['shapes'])} shapes)")
            elif t == 'beat': print(f"  <- beat {msg['index']}: {msg['say']!r}")
            elif t == 'reveal': print(f"  <- reveal {msg['ids']}")
            elif t == 'audioStart': audio_bytes = 0; print('  <- audioStart (Rime marlu streaming…)')
            elif t == 'audioEnd':
                print(f'  <- audioEnd: {audio_bytes} bytes of REAL mp3 audio ✓')
                await ws.send(json.dumps({'type': 'stop'}))
                print('  (stopped after first spoken beat — pipeline proven)')
                break
            elif t == 'speak': print(f"  <- speak(FALLBACK, no Rime): {msg['text']!r}"); break
            elif t == 'error': print('  <- ERROR', msg['message']); break


asyncio.run(main())
