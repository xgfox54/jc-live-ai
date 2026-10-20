# JJ-LIVE 도의회 회의록 AI 기록 플랫폼

공식 방송 음원을 수집해 한국어 전사문을 생성하는 웹서비스. 현재 코드와 실행 화면의 이름은 JC-LIVE.

![프로젝트 아이콘](public/icon-192.png)

## 구현 기능

| 구분 | 기능 |
|---|---|
| 이용자 화면 | 방송 8개 중 최대 2개 선택, 큰 영상, 전체 화면, 소리 전환, 방송별 전사문 검색 |
| 관리자 화면 | 접근키 인증, 방송 등록·수집, 전사문 검토·수정, 세부 설정, 동기화 점검 |
| 자동 수집 | 승인된 방송 주소의 시작 감지, 원음 저장·전사, 종료 처리, 연결 실패 재시도 |
| 전사 처리 | 방송별 세션·음성 대기열과 공유 GPU 워커, 누락 기록, 수정 이력 보존 |
| 아이콘 | 사용자 제공 이미지로 브라우저 탭·홈 화면·상단 아이콘 설정 |

기본 주소: 이용자 http://127.0.0.1:4320/ , 관리자 http://127.0.0.1:4320/admin

## 설치·실행

현재 실행 기준은 Windows, Node.js 24.18 이상 25 미만, Vulkan 지원 GPU 환경. JavaScript 의존 패키지 설치 없이 자동 테스트 실행 가능. 실제 전사에는 모델·워커·FFmpeg·yt-dlp 별도 준비 필요.

~~~powershell
git clone https://gitlab.aigov.go.kr/memory365/jj-live-ai.git
Set-Location jj-live-ai
Copy-Item config.example.json config.local.json
npm test
~~~

[실행 환경 준비 안내](docs/DEPLOYMENT.md)에 따라 실행 자산 배치 후 시작.

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-live.ps1
~~~

service.ready 출력 후 이용자 주소 접속. 관리자 화면에는 최초 실행 시 생성되는 data/access.secret의 adminToken 입력. 이용자 접근키 입력 없음.

## 방송 시작 자동 감지

영상 등록에서 ‘방송 시작 시 자동 녹음·전사’ 선택 후 저장. YouTube 개별 영상 주소 또는 지원되는 의회 방송 상세 주소 대상.

- 기본 확인 간격 30초. 조회 시간에 따라 시작 감지가 추가 지연될 수 있음.
- PC와 서버 실행 중에만 동작. 브라우저를 닫아도 서버가 실행 중이면 감지 지속.
- 예약 방송·일반 영상·종료된 다시보기는 자동 수집 제외.
- 자동 수집은 원음 저장 포함. 저장 한도 도달·저장 오류 시 감지 중단.
- ‘수집 중지’는 자동 감지도 해제. ‘자동 감지 끄기’만 누르면 진행 중인 수집 유지.
- 탭 공유·로컬 파일은 수동 시작. YouTube 채널에서 새로운 방송 주소를 찾는 기능은 미구현.

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
| config.local.json | PC별 경로와 실행 설정 |

위 운영 자료는 Git과 소스 압축파일에서 제외. 기존 StreamRecord의 DB·키와 공유하지 않음.

## 검증·GitLab CI

~~~powershell
npm test
~~~

2026-10-20 기준 자동 테스트 42개 통과. 실제 FFmpeg·GPU 엔진으로 합성 음성 30초 저장·전사 확인. 실제 생방송 시작 순간의 감지 시험과 구분. 자세한 내용은 [현재 작업 정리](docs/STATUS-2026-10-20.md)와 [기존 데스크톱 시험](TEST_RESULTS.md) 참조.

GitLab CI는 자동 테스트, SAST, 비밀정보 탐지 및 소스 압축파일 생성 구성. Runner와 검사 이미지에 접근 가능한 환경 필요. CI 압축파일은 실행 바이너리와 모델을 포함하지 않는 소스 배포본.

## 적용 범위·출처

서버는 로컬 루프백 주소에 바인딩. 외부 서비스 운영용 도메인·HTTPS·인증·접근 제어 구성은 별도 작업 대상. GitLab에 소스를 게시하는 것과 실행 서비스를 인터넷에 공개하는 것은 별개.

전사문은 AI 초안이며 영상과 표시 시점이 다를 수 있음. 30초 영상 정밀 동기화, 사람이 검수한 정답 대비 정확도, 장시간 운영·다중 접속 성능은 현재 버전에서 미검증.

라이선스와 출처: [LICENSE](LICENSE), [ORIGIN.md](ORIGIN.md), [UPSTREAM-LICENSE.md](UPSTREAM-LICENSE.md), [외부 라이선스](licenses/).
