# Render 배포 준비 가이드

이 폴더 전체를 GitHub 저장소 루트로 업로드하면 됩니다. `data/state.json`, `data/settings.json`, `.env`는 업로드하지 않습니다.

## 1. GitHub 준비

1. GitHub에서 새 repository를 만듭니다.
2. 이 폴더 안의 파일을 repository 루트에 업로드합니다.
3. repository는 가능하면 Private로 시작하세요.
4. API 키는 GitHub에 절대 올리지 않습니다.

## 2. Render Web Service 생성

1. Render Dashboard에서 `New` > `Web Service`를 선택합니다.
2. GitHub 계정을 연결하고 이 repository를 선택합니다.
3. Runtime은 `Node`로 둡니다.
4. Build Command는 `npm install`입니다.
5. Start Command는 `npm start`입니다.
6. Health Check Path는 `/api/health`입니다.

`render.yaml`이 있으므로 Blueprint로 생성해도 됩니다. 수동 생성 화면에서도 위 값 그대로 입력하면 됩니다.

## 3. Render 환경변수

Render 서비스의 Environment 탭에서 아래 값을 넣습니다.

| Key | Value |
| --- | --- |
| `PUBG_API_KEY` | PUBG Developer API 키 |
| `PUBG_USE_MOCK` | `0` |
| `HOST` | `0.0.0.0` |
| `NODE_VERSION` | `22` |

Render는 포트를 `PORT` 환경변수로 주입합니다. 앱이 자동으로 이 값을 사용합니다.

## 4. 배포 후 확인

배포가 끝나면 Render URL이 생깁니다.

- 관리자: `https://서비스명.onrender.com/`
- 일반전 OBS: `https://서비스명.onrender.com/overlay/normal`
- 경쟁전 OBS: `https://서비스명.onrender.com/overlay/ranked`
- 사용자지정 OBS: `https://서비스명.onrender.com/overlay/custom`

OBS Browser Source에는 위 오버레이 URL을 넣고 배경 투명 옵션을 켭니다.

## 5. 중요한 주의점

- Render Free 인스턴스는 잠들거나 재시작될 수 있습니다. 방송 중 안정성을 원하면 유료 인스턴스를 권장합니다.
- 현재 기록 상태는 서버 파일시스템에 저장됩니다. 재시작/재배포 시 상태가 초기화될 수 있습니다.
- 장시간 방송에서 상태 보존이 중요하면 Render Persistent Disk를 추가하고 `DATA_DIR` 환경변수를 디스크 경로로 지정하세요.
- 관리자 화면은 공개 URL입니다. URL을 공개 채팅에 올리지 말고, OBS에는 `/overlay/...` URL만 사용하세요.

## 6. Render에서 흔한 실패 원인

- `PUBG_API_KEY`를 환경변수에 넣지 않음
- `HOST`가 `0.0.0.0`이 아님
- Start Command가 `npm start`가 아님
- GitHub에 `.env`를 올려 API 키가 노출됨
