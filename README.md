# JC-LIVE

독립 방송 전사 웹서비스. 입력별 PCM·큐·세션과 공유 GPU 워커 구성. 기본 열람 주소는 `http://127.0.0.1:4320`.

## 실행

Node.js 24.18 이상 25 미만, Vulkan 지원 GPU 드라이버 필요. 이 PC에는 독립 모델·FFmpeg·yt-dlp·전사 워커 준비.

```powershell
Set-Location 'C:\Users\USER\Documents\Codex\JC-LIVE'
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-live.ps1
```

`service.ready` 출력 후 로컬 주소 접속. `data/access.secret`의 관리자 키 또는 열람 키를 화면에 입력. 키 파일 공유 금지.

관리 화면에서 YouTube 입력과 아래 주소 등록 후 수집 시작.

```text
https://www.youtube.com/live/k349Q6iyR_0
```

## 중지·데이터

```powershell
node scripts/stop-live.mjs config.local.json
```

서버 터미널 Ctrl+C로도 정상 종료 요청. 종료 후 `data/`와 설정 백업. 전사·수정 이력은 `data/live.sqlite`, 엔진 로그는 `data/engine.log`, 선택적 원음은 `data/recordings/`에 저장. 기존 StreamRecord DB·키와 공유하지 않음.

## 시험

```powershell
npm test
npm run test:live
```

라이브 시험은 지정 영상의 현재 상태 확인 후 약 60초 수집·전사. 결과는 새 `reports/live-날짜/` 폴더에 저장. 종료·비공개 방송은 실제 결과대로 실패 또는 다시보기로 기록.

기존 8개 입력·300개 연결 측정은 분리 이전 구현의 결과이며 JC-LIVE에서 새로 수행한 결과와 구분. 30초 정밀 영상 동기화와 외부 공개 운영은 미검증. 시험 후 자동 공개 배포나 시작프로그램 등록 없음.

## 빌드

```powershell
scripts/build-worker.ps1 -VisualStudioEnvironment '개발자 환경 배치 경로' -VulkanSdk 'Vulkan SDK 경로' -ClangDirectory 'LLVM bin 경로' -TargetDirectory "$PWD\.build\target"
Copy-Item '.build/target/release/jc-live-worker.exe' 'bin/jc-live-worker.exe'
```

도구 경로는 해당 PC 환경에 맞게 지정. 소스 패키지에는 bin/·models/·운영 데이터 제외. 다른 PC에서는 독립 실행 자산과 GPU 환경 준비 필요.
