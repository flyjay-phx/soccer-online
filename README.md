# 3D 축구 온라인 (프로토타입)

3대3 실시간 대전입니다. 빈자리는 AI가 채우고, 골키퍼는 양쪽 모두 AI입니다.
서버가 경기를 계산하고(서버 권한, 60Hz), 접속한 사람에게 초당 30번 상태를 보냅니다.

## 파일

| 파일 | 역할 |
|---|---|
| `server.js` | 게임 서버 (웹 페이지 + 웹소켓 `/ws`, 방마다 경기 진행). 외부 패키지 없음 |
| `public/sim.js` | 경기 로직 (공 물리, 선수 조작, 태클·커트·헤딩, 골키퍼·AI). 서버와 화면이 같이 씀 |
| `public/client.js` | 화면 (3D 그리기, 입력 전송, 100ms 보간) |
| `public/index.html` | 접속 화면, 대기실, HUD |

## 고정 주소 배포 (Render)

`render.yaml`에 설정이 들어 있습니다. Render에서 이 저장소를 Blueprint로 연결하면
`node server.js`로 실행되고, `/health`로 상태를 확인합니다.
무료 요금제는 15분 동안 접속이 없으면 잠들고, 다음 첫 접속 때 30초쯤 걸려 깨어납니다.

## 실행 (이 PC에서)

```powershell
node server.js
```

브라우저에서 http://localhost:8080 을 엽니다.

## 친구에게 주소 주기 (Cloudflare 임시 터널)

서버를 켠 상태에서 다른 창에서:

```powershell
.\tools\cloudflared\cloudflared.exe tunnel --no-autoupdate --url http://localhost:8080
```

출력에 나오는 `https://….trycloudflare.com` 주소를 친구에게 보냅니다.
- 이 PC와 두 프로그램이 켜져 있는 동안만 접속됩니다.
- 터널을 다시 켜면 주소가 바뀝니다.
- 방 이름을 같게 쓰면 같은 경기에 들어옵니다. 초대 주소: `주소/?room=방이름`

## 설정

- `PORT` (기본 8080), `TEAM_SIZE` (기본 3)
