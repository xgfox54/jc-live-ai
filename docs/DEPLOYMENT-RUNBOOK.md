# 검증·운영 적용·복구 절차

대상: YKH `ykh1/jc-live`, 공개 주소 `https://jc-live-ykh1.vercel.app/`.

## 2026-10-25 작업 경계

- 소스: `C:/Users/USER/Documents/Codex/JC-LIVE-desktop-20261020-r1/JC-LIVE`.
- 시작 커밋: `9465c1e6d95adde80c4b4bfe76fca056da393f6f`. 로컬 브랜치: `work/usage-control-20261025`.
- 원격: `https://gitlab.aigov.go.kr/memory365/jc-live-ai.git`. 작업지시서의 `jj-live-ai`는 실제 원격과 다르므로 사용하지 않음.
- 관리 API의 최근 배포 10건은 CLI 경로. 현재 GitLab CI는 검사·소스 산출물 작업이며 배포 job 없음. 데이터 갱신은 코드 배포와 무관.
- 이번 작업에서는 commit/push, Preview/Production 배포, 운영 프로세스 재시작, 설정 변경·삭제 미실시.

## 로컬 검증 명령

저장소 루트에서 실행. 테스트는 임시 DB와 mock 저장소 사용.

```powershell
& ./bin/node/node.exe --test test/*.test.mjs
& ./bin/node/node.exe scripts/build-web.mjs
& ./bin/node/node.exe scripts/bench-publication-idle.mjs
& ./bin/node/node.exe scripts/bench-cloud-usage.mjs
& ./bin/node/node.exe scripts/usage-model.mjs reports/cloud-usage-default-model.json
& ./bin/node/node.exe scripts/release-impact.mjs --base 9465c1e6d95adde80c4b4bfe76fca056da393f6f
git diff --check
```

비교 기준은 마지막 성공 배포에 대응하는 로컬 커밋으로 교체. HEAD~1 사용 금지. 이력 불명·shallow clone·미커밋 변경은 보수적으로 빌드 필요 판정. `--ignored-build-step`은 생략 0, 빌드 1을 반환하며 실제 Vercel 설정에는 아직 연결하지 않음.

## 승인 후 운영 적용

1. 현재 운영 소스·배포 ID·활성 게시자 PC와 실제 Usage 집계 기간 재확인. 기존 `DEPLOYMENT_DISABLED`의 해제는 코드 수정과 별도 절차.
2. 운영자가 선택한 게시자 한 대를 기준으로 로컬 DB의 일관된 백업과 SHA-256 검증. 녹음·후보정·회의록·설정 파일 보존, 비밀은 Git·보고서·배포물에서 제외. SQLite 사용 중 단일 DB 파일만 복사하지 말고 온라인 백업 또는 정상 종료 뒤 WAL까지 보존.
3. 로컬 검사·소스 보안 검사 후 승인된 변경 묶음 커밋과 push. 릴리스 후보와 마지막 성공 배포의 diff 확인.
4. Linux x64 검증 환경에서 공개 자산 생성, `web`에서 `npm ci --ignore-scripts`와 `node deployment/build.mjs` 실행. 현재 Windows에서는 이 단계의 실제 실행 미검증. Linux Node 24.22.1, SHA-256, 실행 권한, 심볼릭 링크, OIDC wrapper, 경로별 헤더와 정적 자산 읽기를 확인한 뒤 배포 승인 판단.
5. `.vercel/output`만 배포. 로컬 DB·설정·녹음·`data/access.secret`와 `data/cloud-sync.secret` 제외. 기존 보안 헤더·공개 허용목록·비공개 Blob 유지. 신규 저장소 생성 불필요.
6. 전역 게시자 보호를 적용하려면 서버 `JC_PUBLISHER_ID` 등록 필수. 별도 설정 변경 승인 후 아래 읽기 전용 명령의 `publisher_id`를 한 게시자와 대조해 등록. 미설정 상태는 기존 객체별 소유권만 보호하며 다른 인증된 게시자의 새 경로 생성을 막지 못함. 토큰과 다르지만 운영 식별자이므로 공개 문서에 복사하지 않음. 기존 전송키와 일치하는 인증도 별도 확인.
7. 새 API를 먼저 적용하고 최소 조회·인증 거부·조건부 쓰기 검증. 이후 승인받은 로컬 게시자만 새 코드로 재시작. 구형 게시자가 동시에 쓰지 않도록 운영자 확인. 다른 PC를 임의 중지하지 않음.
8. 최초 게시, 변경 없는 두 주기, 새 문장·후보정 교체, 최종 회의록, 401/403 및 공개 원문 경계 확인. 실제 CDN HIT·Blob 작업 수·함수 실행·비용은 관리 지표로 별도 기록.

Node 런타임은 공식 압축파일의 고정 SHA-256을 매번 검증. warm cache는 다운로드만 생략하며 검증 생략 없음. lockfile의 production 의존성 폐쇄 집합 31개와 라이선스 보존. 현재 복사량 절감은 14,593바이트에 불과하며 큰 저장공간 절감으로 평가하지 않음. 표준 Vercel 런타임으로 전환하려면 보안 패치 동등성과 OIDC 계약을 먼저 검증해야 함.

## 게시 차단 점검·재개

실제 DB 경로는 `config.local.json`의 `database`와 대조. 다음 명령의 기본 동작은 읽기 전용이며 토큰·본문 출력 없음.

```powershell
& ./bin/node/node.exe scripts/publication-state.mjs --db data/live.sqlite --settings data/cloud-sync.secret
```

`metrics`는 로컬 승인 시도·HTTP POST·승인된 쓰기·중복 승인·원인별 실패·본문 바이트. 실제 과금·SDK 내부 네트워크 수치가 아님. `queued`, `blocked_reason`을 함께 확인. 인증·소유권·한도 원인을 해결하기 전 재개 금지.

운영자가 게시자를 정상 중지한 뒤 승인된 재개 작업:

```powershell
& ./bin/node/node.exe scripts/publication-state.mjs --db data/live.sqlite --settings data/cloud-sync.secret --resume
```

원격 요청은 실행하지 않으며 대기 항목·기존 요청 ID·원본 기록 보존. 새 게시자 시작은 별도 승인 범위. `force`로는 차단 해제 불가.

공급자 집계 기간 변경을 실제로 확인했을 때만 로컬 비밀 설정 파일의 `budget.period_id`와 `advanced_used`를 수정. 이어 `--review-budget-period --resume` 실행. 같은 기간 재설정은 거부. 달력상 다음 달이라는 이유로 카운터 초기화 금지. 다른 프로젝트·이전 시도를 포함한 실제 사용량을 기준값으로 반영.

## 중지·롤백

- 원격 게시 장애 시 로컬 수집 중지 대신 게시 차단 상태 유지. 원문·회의록 삭제 금지. 안전한 로컬 점검은 별도 fixture 사용.
- `CloudPublisher.close()`는 요청을 취소하고 대기 상태를 남김. 최종 flush도 간격·예산 제한을 따르므로 종료 직전 모든 자료가 원격에 올라갔다고 가정하지 않음. 재시작 후 대기 수·최종 문서 확인.
- 화면 문제가 발생하면 호환되는 API·새 게시 프로토콜을 유지한 상태에서 정적 화면만 이전 버전으로 복귀 검토.
- 추가된 `cloud_control`, `cloud_outbox` 테이블은 기존 테이블을 삭제·변경하지 않음. 구형 Store의 기존 자료 읽기는 유지되지만, 구형 CloudPublisher를 다시 켜면 새 객체에 대한 게시가 409로 거부됨.
- 전체 구버전으로 복귀해야 하면 게시를 차단하고 운영자가 승인한 프로토콜 이행 계획 필요. Blob·DB 삭제로 우회 금지. 원본 데이터 복구와 공개 게시 복구를 구분하고 백업 복원 검증 후 재개.
- 이전 배포 삭제·유료 전환·신규 서비스 연결은 이번 범위 밖. 요청량은 과거 배포를 삭제해도 회복되지 않음.
