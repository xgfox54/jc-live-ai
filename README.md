# JC-LIVE 도의회 회의록 AI 기록 플랫폼

2026-10-20 랩탑 인계본 복원 후 웹 검토 기능 추가. 기능·실행·검증 범위는 [적용 결과](docs/FEATURE_PARITY.md) 참조. 수동 검토 실행은 `node src/main.mjs config.local.json --manual`이며 자동 수집·공개 전송을 시작하지 않음.

공식 방송 음원을 수집해 한국어 전사문과 검토용 회의록을 생성하는 웹서비스.

![프로젝트 아이콘](public/icon-192.png)

## 구현 기능

| 구분 | 기능 |
|---|---|
| 이용자 화면 | 위원회별 12개 채널 중 최대 2개 선택, 큰 영상, 전체 화면, 소리 전환, AI 후보정문 검색 |
| 위원 명단 | 선택한 채널 왼쪽에 의원 사진·이름·직책·선거구, 공식 소개 링크·출처·확인일 표시 |
| 관리자 화면 | 접근키 인증, 방송 등록·수집, 전사문 검토·수정, 세부 설정, 동기화 점검 |
| 자동 수집 | 공식 YouTube 채널·홈페이지의 신규 생방송 주소 발견·중복 제거·등록, 시작 감지, 원음 저장·전사, 종료 처리 |
| 회의록 | 공식 안건·발언 발췌, 근거 인용을 대조한 AI 구조화 초안, 직접 편집·작업 재개, Markdown·JSON 내려받기 |
| 전사 처리 | 방송별 세션·음성 대기열과 공유 GPU 워커, 누락 기록, 수정 이력 보존 |
| 장애 대비 | 데스크탑 우선·랩탑 대기 자동 전환, 수집 PC가 바뀌어도 영상 시간 기준으로 이어서 전사 |
| AI 후보정 | Ollama·OpenCodex 호환 프록시, 여러 연결 보관, 자동 후보 생성, 경고·선택 적용, 경고 없는 후보 자동 적용 선택 |
| 분야별 단어장 | StreamRecord의 11개 분야, 방송별 선택과 추가 참고어, 최대 3,000자 |
| 아이콘 | 사용자 제공 이미지로 브라우저 탭·홈 화면·상단 아이콘 설정 |

기본 주소: 이용자 http://127.0.0.1:4320/ , 관리자 http://127.0.0.1:4320/admin

회의록 주소: http://127.0.0.1:4320/minutes

공개 웹사이트: https://jc-live.xgfox54.workers.dev/ , 공개 회의록: https://jc-live.xgfox54.workers.dev/minutes (Cloudflare). Vercel 주소 https://jc-live-ykh1.vercel.app/ 는 2026-11-13 확인 기준 사용 중지 상태(HTTP 402).

Vercel 공개 화면과 PC의 수집·전사 서버 연결 방법은 [Vercel 운영 안내](docs/VERCEL.md) 참조. 게시·조회 사용량과 무료 한도 판정은 [사용량 제어 구조](docs/ARCHITECTURE-COST-CONTROL.md), 검증·적용·복구 명령은 [배포 운영 절차](docs/DEPLOYMENT-RUNBOOK.md) 참조. 현재 운영은 [Cloudflare 운영 문서](docs/CLOUDFLARE.md), 데스크탑 장애 때 랩탑이 대신 전사하는 구조는 [데스크탑 우선·랩탑 대기 운영](docs/LAPTOP-STANDBY.md) 참조.

위원회별 채널 배정과 명단 갱신 방법은 [위원회 채널 안내](docs/COMMITTEES.md) 참조. 위원회 12개와 일반 방송용 채널0번을 합쳐 13개이며 동시 전사 입력은 최대 8개.

실시간 화면은 공개 검증을 거친 1차 받아쓰기를 먼저 표시하고 같은 구간의 AI 후보정문으로 교체. 과거 검색·회의록·JSON·Markdown은 후보정이 적용된 공개 자료만 제공. 원본 DB와 수정 이력, 아직 적용하지 않은 AI 후보는 관리자 영역에서 보존. 일반 전사 조회 API는 관리자 인증 필요. 공개 조회는 `/api/viewer/` 사용.

후보정 연결·단어장·장시간 처리 범위는 [후보정·장시간 운영](docs/AI-CORRECTION.md) 참조.

## 설치·실행

현재 실행 기준은 Windows, Node.js 24.22.1 이상 25 미만, Vulkan 지원 GPU 환경. 전체 자동 테스트에는 웹 SDK 설치(`npm ci --prefix web --ignore-scripts`)와 웹 배포본 생성(`npm run build:web`) 선행 필요. 웹 배포본 비교 시험이 생성된 `web/public` 파일을 읽음. 실제 전사에는 모델·워커·FFmpeg·yt-dlp 별도 준비 필요.

~~~powershell
git clone https://github.com/xgfox54/jc-live-ai.git
Set-Location jc-live-ai
Copy-Item config.example.json config.local.json
npm ci --prefix web --ignore-scripts
npm run build:web
npm test
~~~

[실행 환경 준비 안내](docs/DEPLOYMENT.md)에 따라 실행 자산 배치 후 시작.

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-live.ps1
~~~

service.ready 출력 후 이용자 주소 접속. 관리자 화면에는 최초 실행 시 생성되는 data/access.secret의 adminToken 입력. 이용자 접근키 입력 없음.

## 방송 시작 자동 감지

서버 실행 시 제주특별자치도의회 공식 YouTube 생방송 채널과 홈페이지의 신규 주소 탐색 기본 활성화. 관리자 ‘신규 방송 자동 등록’ 메뉴에서 조회 상태 확인·탐색 중지·재개. 방송 시작 부분부터 수집을 요청하고 전사문을 바탕으로 회의록 초안 작성. 제공자의 보관 범위에 따라 시작 부분 누락 가능. 전체 수록 보장 아님.

등록 대기·중복 통합·오류 복구·회의록 구성과 검증 범위는 [자동 등록·회의록 안내](docs/AUTOMATION.md) 참조.

영상 등록에서 ‘방송 시작 시 자동 녹음·전사’ 선택 후 저장. YouTube 개별 영상 주소 또는 지원되는 의회 방송 상세 주소 대상.

- 기본 확인 간격 30초. 조회 시간에 따라 시작 감지가 추가 지연될 수 있음.
- PC와 서버 실행 중에만 동작. 브라우저를 닫아도 서버가 실행 중이면 감지 지속.
- 예약 방송·일반 영상·종료된 다시보기는 자동 수집 제외.
- 자동 수집은 원음 저장 포함. 저장 한도 도달·저장 오류 시 감지 중단.
- ‘수집 중지’는 자동 감지도 해제. ‘자동 감지 끄기’만 누르면 진행 중인 수집 유지.
- 탭 공유·로컬 파일은 수동 시작.

상태 정의 참고: [yt-dlp 공식 문서](https://github.com/yt-dlp/yt-dlp#output-template).

## 중지·데이터

~~~powershell
node scripts/stop-live.mjs config.local.json
~~~

서버 터미널 Ctrl+C로도 정상 종료 요청. 종료 후 data/와 개인 설정 백업.

| 경로 | 용도 |
|---|---|
| data/live.sqlite | 방송·세션·전사문·수정 이력 |
| data/access.secret | 관리자·기존 열람 API 키 |
| data/engine.log | 전사 엔진 로그 |
| data/recordings/ | 원음 저장 |
| data/minutes/ | 방송별 회의록 Markdown·JSON |
| config.local.json | PC별 경로와 실행 설정 |

위 운영 자료는 Git과 소스 압축파일에서 제외. 기존 StreamRecord의 DB·키와 공유하지 않음.

## 검증·GitLab CI

~~~powershell
npm test
~~~

2026-11-14 기준 자동 테스트 384개 중 383개 통과, 1개 건너뜀(네이티브 모델 로더). 실행 파일·모델이 없는 새 사본(추적 파일만 있는 상태)에서는 실제 디코더 시험 4개가 추가로 건너뜀(2026-11-15 확인, 384개 중 379개 통과). 2026-10-20에는 실제 FFmpeg·GPU로 합성 음성 58.93초와 공식 YouTube 다시보기 35.01초의 저장·전사·회의록 생성 및 정상 종료 확인. 새 생방송의 실제 시작 순간은 검증 시점에 방송이 없어 미확인. 자세한 내용은 [자동 등록·회의록 검증](docs/AUTOMATION.md), [이전 작업 정리](docs/archive/STATUS-2026-10-20.md), [기존 데스크톱 시험](docs/archive/TEST_RESULTS.md) 참조.

원본 배포는 GitHub(xgfox54/jc-live-ai). GitHub에서는 CI를 실행하지 않음. 커밋 전 비밀정보 검사(pre-commit)와 로컬 자동 테스트로 확인. `.gitlab-ci.yml`(자동 테스트, SAST, 비밀정보 탐지, 소스 압축파일)은 GitLab 원격을 다시 쓸 때를 위해 보존. GitLab 원격(gitlab.aigov.go.kr)은 2026-10-24 이후 사용하지 않았고 2026-11-14 확인 때 저장소 주소가 응답하지 않음.

## 적용 범위·출처

Cloudflare 운영 주소: https://jc-live.xgfox54.workers.dev/ . 데스크톱 실시간 연결·완료 회의록 저장·Vercel 병행 설정과 실제 검증 결과는 [Cloudflare 운영 문서](docs/CLOUDFLARE.md) 참조.

수집·전사 서버는 로컬 루프백 주소에 바인딩. Vercel의 HTTPS 공개 화면에는 PC에서 공개 자료만 전송. 녹음·전사·관리자 기능은 PC 서버 실행 필요.

전사문은 AI 초안이며 영상과 표시 시점이 다를 수 있음. 30초 영상 정밀 동기화, 사람이 검수한 정답 대비 정확도, 장시간 운영·다중 접속 성능은 현재 버전에서 미검증.

라이선스와 출처: [LICENSE](LICENSE), [ORIGIN.md](ORIGIN.md), [UPSTREAM-LICENSE.md](UPSTREAM-LICENSE.md), [외부 라이선스](licenses/).
