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
| AI 후보정 | Ollama·OpenCodex 호환 프록시, 여러 연결 보관, 자동 후보 생성, 경고·선택 적용, 경고 없는 후보 자동 적용 선택 |
| 분야별 단어장 | StreamRecord의 11개 분야, 방송별 선택과 추가 참고어, 최대 3,000자 |
| 아이콘 | 사용자 제공 이미지로 브라우저 탭·홈 화면·상단 아이콘 설정 |

기본 주소: 이용자 http://127.0.0.1:4320/ , 관리자 http://127.0.0.1:4320/admin

회의록 주소: http://127.0.0.1:4320/minutes

공개 웹사이트: https://jc-live-ykh1.vercel.app/ , 공개 회의록: https://jc-live-ykh1.vercel.app/minutes

Vercel 공개 화면과 PC의 수집·전사 서버 연결 방법은 [Vercel 운영 안내](docs/VERCEL.md) 참조.

위원회별 채널 배정과 명단 갱신 방법은 [위원회 채널 안내](docs/COMMITTEES.md) 참조. 등록 채널은 12개이며 동시 전사 입력은 최대 8개.

이용자에게는 AI 후보정이 적용된 문장만 제공. 원문·미확정 문장·아직 적용하지 않은 AI 후보는 공개하지 않음. 후보정 전에는 대기 안내 표시. 검색·실시간 이벤트·회의록·JSON·Markdown에도 같은 기준 적용. 원문과 수정 이력은 관리자 영역에서 보존. AI 미구성·오류·중단 시 원문으로 대체하지 않음. 일반 전사 조회 API는 관리자 인증 필요. 공개 조회는 `/api/viewer/` 사용.

후보정 연결·단어장·장시간 처리 범위는 [후보정·장시간 운영](docs/AI-CORRECTION.md) 참조.

## 설치·실행

현재 실행 기준은 Windows, Node.js 24.18 이상 25 미만, Vulkan 지원 GPU 환경. JavaScript 의존 패키지 설치 없이 자동 테스트 실행 가능. 실제 전사에는 모델·워커·FFmpeg·yt-dlp 별도 준비 필요.

~~~powershell
git clone https://gitlab.aigov.go.kr/memory365/jc-live-ai.git
Set-Location jc-live-ai
Copy-Item config.example.json config.local.json
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

2026-10-20 기준 자동 테스트 74개 통과. 실제 FFmpeg·GPU로 합성 음성 58.93초와 공식 YouTube 다시보기 35.01초의 저장·전사·회의록 생성 및 정상 종료 확인. 새 생방송의 실제 시작 순간은 검증 시점에 방송이 없어 미확인. 자세한 내용은 [자동 등록·회의록 검증](docs/AUTOMATION.md), [이전 작업 정리](docs/STATUS-2026-10-20.md), [기존 데스크톱 시험](TEST_RESULTS.md) 참조.

GitLab CI는 자동 테스트, SAST, 비밀정보 탐지 및 소스 압축파일 생성 구성. Runner와 검사 이미지에 접근 가능한 환경 필요. CI 압축파일은 실행 바이너리와 모델을 포함하지 않는 소스 배포본.

## 적용 범위·출처

수집·전사 서버는 로컬 루프백 주소에 바인딩. Vercel의 HTTPS 공개 화면에는 PC에서 공개 자료만 전송. 녹음·전사·관리자 기능은 PC 서버 실행 필요.

전사문은 AI 초안이며 영상과 표시 시점이 다를 수 있음. 30초 영상 정밀 동기화, 사람이 검수한 정답 대비 정확도, 장시간 운영·다중 접속 성능은 현재 버전에서 미검증.

라이선스와 출처: [LICENSE](LICENSE), [ORIGIN.md](ORIGIN.md), [UPSTREAM-LICENSE.md](UPSTREAM-LICENSE.md), [외부 라이선스](licenses/).
