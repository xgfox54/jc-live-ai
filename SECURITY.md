# 보안 정책

## 취약점 신고

- 공개 이슈에 취약점 세부 내용·재현 방법·키 값 기재 금지.
- 신고는 GitLab 비공개(confidential) 이슈 또는 저장소 관리자에게 직접 전달.
- 신고 내용: 영향 범위, 재현 조건, 확인한 버전 또는 커밋.

## 적용 중인 보안 통제

| 영역 | 통제 |
|---|---|
| 관리자 기능 | 로컬 루프백(127.0.0.1) 전용. 모든 /api/admin 경로에서 서버가 관리자 키 확인. 상수 시간 비교, 반복 인증 실패 시 요청 제한 |
| 요청 출처 | Host·Origin·Sec-Fetch-Site 검사. 다른 출처 요청 거부. CORS 허용 헤더 미발행 |
| 화면 보호 | 콘텐츠 보안 정책(CSP), X-Frame-Options DENY, nosniff, Referrer-Policy, COOP·CORP, Permissions-Policy, HSTS(Vercel) |
| 입력 검증 | 식별자·URL·숫자 범위 검증, 요청 크기 제한, 공개 자료 스키마 검증 |
| 외부 요청 | 방송·의회 조회는 허용 호스트 고정과 리디렉션 거부. AI 프록시 주소의 링크 로컬·메타데이터 주소 차단 |
| 파일 처리 | 업로드 확장자·파일 서명·크기 검사, 서버 생성 파일 이름, 저장 경로 루트 검사 |
| 데이터베이스 | 준비된 문장과 값 바인딩 |
| 공개 범위 | 공개 화면과 Vercel API는 AI 후보정 문장만 제공. 원문·원음·관리 기록 비공개 |
| 비밀 관리 | 키 파일·설정·DB·녹음은 Git 제외. 커밋 전 비밀 탐지 훅(scripts/check-secrets.mjs), GitLab 비밀정보 탐지·SAST, 키 교체 스크립트(scripts/rotate-secrets.mjs) |

## 운영 규칙

- data/, reports/, config.local.json, .env 계열 파일은 저장소·CI 변수·이슈에 복사 금지.
- 키 노출이 의심되면 서버 종료 후 `node scripts/rotate-secrets.mjs config.local.json` 실행. 공개 전송키도 바꾸려면 `--cloud` 추가 후 Vercel 변수 갱신·재배포.
- 세부 점검표와 남은 위험 목록은 공개 저장소에 두지 않고 운영 PC의 비공개 보고서로 관리.
