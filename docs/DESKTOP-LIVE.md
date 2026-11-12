# 데스크톱 실시간 전달

작성일: 2026-10-25

현재 운영 적용·상태 전달 주기·검증 결과는 [Cloudflare 및 Vercel 병행 운영](CLOUDFLARE.md) 참조. 아래 내용은 Cloudflare 적용 전 최초 구현·시험 시점의 기록을 포함함.

## 구현 범위

현재 작업 저장소: `C:/Users/USER/Documents/Codex/JC-LIVE-desktop-20261020-r1/JC-LIVE`

브랜치: `work/usage-control-20261025`

| 처리 | 담당 |
|---|---|
| 방송 수신, Whisper 전사, 화자분리, 후보정 작업 관리 | 기존 데스크톱 엔진 |
| 웹 화면, 글꼴, 이미지 | Vercel 정적 파일 |
| 실시간 초안, 후보정 교체, 상태, 일정, 과거 받아쓰기 조회 | 데스크톱 조회 전용 HTTP 서버 |
| 종료 후 공개용 회의록과 목록 | 기존 Vercel Blob 게시 제어 |

실시간 화면의 API 요청은 설정된 데스크톱 주소로 직접 전송함. Vercel Functions를 경유하지 않음. 회의록 페이지는 기존 클라우드 API를 유지함. 연결 실패 시 클라우드의 오래된 받아쓰기를 실시간 자료로 대신 표시하지 않음.

기존 `EventFeed`, SQLite 이벤트 번호, 공개 문장 필터, 이전 기록 페이지 조회 재사용. 재접속 시 마지막 이벤트 이후부터 재전송. 이력이 2,000건을 초과하거나 이벤트 번호가 현재 저장소보다 앞서면 화면 자료를 다시 조회함. 이전 구간은 페이지 조회로 복구 가능함.

초안은 `live_preview`가 지정된 공개용 문장만 표시함. 후보정은 같은 문장 식별자의 새 버전으로 교체함. 저장 회의록에는 후보정된 문장만 포함함. 시험 세션, 관리자 설정, 내부 오류, 입력 프롬프트, 비밀은 기존 공개 필터에서 제외함.

## 게시 방식 변경

`desktopLive.enabled=true`이면 실시간 텍스트를 Blob에 게시하지 않음. 사이트 문서는 빈 실시간 자료와 저장 회의록 목록으로 구성함. 최초 목록과 완료본 변경에만 쓰기가 발생함.

아카이브 준비 판정은 기존 `finalReadiness` 재사용. 수집·전사 종료와 진행 중인 후보정 작업을 확인하고 공개 가능한 문장이 있을 때 게시함. 기존 판정은 중단된 세션도 10분 정착 후 보관 대상으로 인정함. 따라서 아카이브 게시가 영상 전체 수집이나 모든 문장 승인 완료를 의미하지 않음. 제외·보류 문장과 누락 안내는 보존함. 후속 후보정·발언자 재검토 결과는 다시 게시함.

기존 전송 결과가 불명확한 실시간 게시 요청이 남아 있으면 자동 전환 게시를 차단함. 대기 요청이나 녹음·전사 데이터 삭제 없음. 상태의 `mode_transition_blocked`로 확인 가능함. 2026-10-25 현재 운영 DB 읽기 전용 확인에서는 대기 요청 0건, 데스크톱 전달 기능 비활성 상태였음.

50개 완료본과 개별 목록 갱신의 기본 저장량은 약 100회이며 최초 목록, 수정본, 재시도는 추가됨. 실제 무료 운영 여부는 외부 연결 서비스의 조건, 사용 시간, 접속자 수, 데이터 전송량에 따라 달라짐. 데스크톱으로 옮겨도 이용자에게 보내는 트래픽 자체가 사라지지는 않음.

## 접속 경계

- 기본값 비활성. 별도 포트는 `127.0.0.1`에만 바인딩.
- 공개 허용 경로는 `/api/viewer/snapshot`, `/api/viewer/events`, `/api/viewer/segments`, `/api/viewer/schedule` 네 개.
- 관리자·파일·원음·회의록 원문 경로와 임의 URL 프록시 없음.
- GET과 제한된 CORS 사전 요청만 허용. Authorization 헤더 전달 금지.
- 허용 Origin 완전 일치. 와일드카드·쿠키 인증 사용 없음. Origin 검사는 브라우저 접근 제어이며 사용자 인증을 대신하지 않음. 이 접속점은 공개용 문장 조회 서비스임.
- 공개 주소는 HTTPS origin으로 제한. 정적 빌드에서 해당 주소 하나만 CSP `connect-src`에 추가.
- SSE 최대 350개 연결, 전체 소켓 최대 1,024개, 요청 초당 1,000개 상한. 전달 버퍼 256KiB, 느린 연결은 종료 후 재접속으로 복구.
- 동일 조회 스냅숏은 최대 1초 메모리 캐시. 캐시 본문 합계 8MiB, 항목당 1MiB 상한. 실시간 이벤트는 캐시 대기 없이 전달. 상태·과거 구간 복구를 위한 5초 조회 유지.
- 프로세스 종료 시 전용 서버·연결·이벤트 리스너 정리.

인터넷에 연결할 때는 HTTPS 종단, 유효한 인증서, SSE 버퍼링 해제, 연결 유지, 외부 요청 제한을 갖춘 역방향 프록시 또는 터널 필요. 연결 대상은 조회 전용 포트만 허용하고 기존 관리자 포트 4320은 외부에 연결하지 않음. 인터넷 대량 공격 방어와 실제 회선 용량은 이번 로컬 시험으로 검증되지 않음.

## 승인 후 운영 적용 순서

아래 항목은 아직 실행하지 않음. 기존 작업지시서의 별도 승인 조건 적용 대상: 외부 연결·포트 개방·신규 서비스 연결·Vercel 설정 변경·Production/Preview 배포·운영 재시작.

1. 사용할 실제 HTTPS 주소와 연결 방식을 확정하고 외부 연결 승인 확보.
2. 기존 설정과 DB를 백업한 뒤 설정의 다른 항목은 유지하고 아래 `desktopLive` 항목 추가. 예시 도메인은 실제 주소로 교체.

```json
{
  "desktopLive": {
    "enabled": true,
    "port": 4321,
    "publicOrigin": "https://live.example.org",
    "allowedOrigins": ["https://jc-live-ykh1.vercel.app"]
  }
}
```

3. 방송 입력이 없는 유지보수 시간에 데스크톱 서비스를 재시작. 조회 전용 포트 확인. 관리자 서버의 기존 주소·인증 유지.
4. 승인받은 HTTPS 프록시를 `127.0.0.1:4321`에 연결. 관리자·쓰기·파일 경로의 404/405, 외부 Origin의 403 확인.
5. 웹 빌드 환경에 `JC_LIVE_DESKTOP_ORIGIN`을 실제 HTTPS origin으로 지정. 값에는 경로·계정정보·토큰을 넣지 않음. `build-web.mjs`로 공개 자산을 준비한 뒤 기존 Linux 빌드·배포 절차 진행. 빌드가 `live-transport.json`과 CSP를 함께 생성함.
6. 실제 외부 브라우저에서 조회·SSE·ETag 사전 요청 확인. 초안 및 후보정 교체, 중단·재접속·과거 기록 확인. 실제 브라우저가 Vercel live API에 접근하지 않는지 확인.
7. 관리자 게시 상태에서 `delivery_mode=desktop`, `mode_transition_blocked=false` 확인. 종료 회의록과 목록의 클라우드 게시 확인.

전환 중에는 기존 클라우드 실시간 화면의 갱신이 잠시 멈출 수 있으므로 방송이 없는 시간에 수행함. 주소 준비 없이 설정부터 켜지 않음. `node src/main.mjs config.local.json --manual`은 클라우드 자동 게시를 끄므로 정상 운영 명령의 대체 수단으로 사용하지 않음.

## 중지·복구·롤백

- 데스크톱 연결 중단: 브라우저는 표시된 문장을 유지하며 재접속 상태 표시. 저장된 이벤트로 재전송. 전사·녹음 데이터는 로컬에 계속 보존.
- 외부 연결만 중지: 승인된 프록시 또는 터널 중지. 관리자 서버와 다른 Ollama 작업은 중지 대상 아님.
- 전달 방식 롤백: `desktopLive.enabled=false`, 웹 빌드 환경의 `JC_LIVE_DESKTOP_ORIGIN` 제거, 기존 클라우드 전송의 한도·차단 상태 확인 후 승인된 재시작과 재배포 수행. 이전 배포만 복원하고 서버를 archive-only로 유지하면 실시간 갱신이 재개되지 않음.
- 전송 결과 불명확한 대기 요청은 삭제하지 않음. 기존 게시 상태 확인 도구로 서버 응답과 로컬 대기 요청을 대조한 뒤 처리.
- 코드 롤백은 아래 변경 파일의 이번 작업 부분만 대상으로 함. 같은 브랜치에 남아 있는 이전 구조개선 변경은 보존.

## 시험 결과

| 시험 | 확인 결과 |
|---|---|
| 전체 자동 테스트 | 322개 중 320개 통과, 2개 건너뜀, 실패 0개 |
| 건너뛴 시험 | SenseVoice CP949 시험, 네이티브 모델 로더 시험. 이 작업에서 모델 실행 없음 |
| 별도 Origin의 실제 Chrome 화면 | 초안 표시·후보정 교체, 중단 중 문장 유지, 재접속 복구 통과 |
| 브라우저의 Vercel live API 요청 | 합성 웹 서버에서 0건 확인 |
| 8개 채널·300개 SSE 연결 | 초안·후보정 및 재접속 메시지 96,300건 모두 수신 |
| 연결 중단·복구 | 50개 연결 재접속, 누락·중복·채널 혼선 오류 0건 |
| 연결 초기 재시도 | 68회. 최초 무재시도 시험에서 ECONNREFUSED 발생. 기존 지수 지연·무작위 재시도로 복구 |
| 텍스트 전달 지연 | 중앙값 104.7ms, 95백분위 123.6ms, 99백분위 128.2ms, 최대 139.1ms |
| 시험 시간·메모리 | 약 6.7초 부하 시험, RSS 증가 약 211MiB |
| 느린 연결 종료 | 부하 시험에서 0건. 버퍼 최고 약 2.9KiB |
| 운영 적용 | 미실시. 운영 설정·프로세스·Vercel 변경 없음 |

부하 결과는 합성 텍스트를 실제 로컬 HTTP/SSE로 전달한 시험임. 8개 실제 음성 전사, GPU 부하, 장시간 유지, 인터넷 300명, TLS 터널, 가정용 회선 장애·속도, 무료 서비스 한도는 미검증임. 기존 Ollama 작업에는 접근하거나 중지 명령을 실행하지 않음.

### 재현 명령

저장소 루트 PowerShell에서 실행:

```powershell
./bin/node/node.exe --test test/*.test.mjs
./bin/node/node.exe scripts/bench-desktop-live.mjs
./bin/node/node.exe scripts/qa-desktop-live.mjs
./bin/node/node.exe scripts/build-web.mjs
```

브라우저 시험은 현재 PC의 Omowright 스킬 경로와 Chrome 설치 경로를 사용함. 다른 PC에서는 해당 경로를 먼저 확인해야 함. 시험 서버는 임시 포트와 합성 메모리 DB를 사용하고 종료 시 정리함.

증거 파일: `reports/desktop-live-full-tests.log`, `reports/desktop-live-cloud-test.log`, `reports/desktop-live/load-result.json`, `reports/desktop-live/browser/result.json`, 같은 폴더의 화면 PNG.

## 변경 파일

- `src/desktop-live.mjs`: 별도 조회 전용 서버, Origin·Host·메서드 검사, 요청 제한.
- `src/server.mjs`, `src/main.mjs`: 선택적 서버 시작·종료, 후보정 준비 상태 연결.
- `src/viewer.mjs`, `src/events.mjs`: 제한된 스냅숏 캐시, 채널 검사, 리스너 정리.
- `src/cloud-publisher.mjs`: 데스크톱 모드에서 실시간 게시 제외, 종료본 게시와 대기 요청 보존.
- `public/live-transport.mjs`, `public/live-transport.json`, `public/app.mjs`: 실시간 요청 주소 선택, 인증정보 없는 직접 연결.
- `scripts/build-web.mjs`, `web/deployment/public-assets.json`: 공개 자산 목록.
- `web/deployment/live-transport.mjs`, `web/deployment/build.mjs`, `web/vercel.json`: 배포용 주소와 CSP, 캐시 설정 생성.
- `test/desktop-live.test.mjs`, `test/cloud.test.mjs`: 보안 경계·재접속·조건부 조회·종료본 게시 시험.
- `scripts/bench-desktop-live.mjs`, `scripts/qa-desktop-live.mjs`: 로컬 부하·브라우저 재현 시험.

Node.js 스트리밍의 역압력 동작은 공식 문서 확인 후 기존 `write()`·`drain` 처리 재사용: https://nodejs.org/docs/latest-v24.x/api/stream.html
