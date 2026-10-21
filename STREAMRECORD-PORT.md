# StreamRecord 기능 이식

- 참고 저장소: https://gitlab.aigov.go.kr/memory365/streamrecord.git
- 기준 커밋: `57a5eb4211a14f8f775339ad9a87aac1e0d4ec9d`
- 이식 범위: AI 전사 후보정 검증, 분야별 단어장 11종, OpenCodex·OpenAI 호환 연결 방식
- 원본 파일: `app/frontend/src/components/meeting-ko/transcript-correction.ts`, `glossary.ts`, `app/frontend/src/components/stream-record/glossary-packs.ts`, `glossary-pack-expansions.ts`, `app/frontend/src-tauri/src/meeting_ko/connections/{adapters,endpoint,transport}.rs`
- JC-LIVE 구현: `src/ai-correction.mjs`, `src/ai-proxy.mjs`, `src/glossary.mjs`, `src/glossary-packs.json`
- 단어장 데이터: 원본의 분야별 대표어·확장어·공통어를 원본 함수로 조합한 결과. 단어장은 후보정 참고 자료이며 공식 용어집이나 자동 치환 규칙이 아님.
- 원문 보존, 숫자·길이 변경 경고, 구간 ID 누락·중복 거부, 직접 수정 우선 원칙 유지
- 원본 Rust·Tauri 저장 방식 대신 Node.js·SQLite 사용. 프록시 키는 서버 인증키에서 파생한 키로 AES-256-GCM 암호화하고 연결 주소에 결합. 관리자 인증키 교체 시 프록시 키 재저장 필요.
- 원본 앱·설정·인증 정보는 수정하지 않음. JC-LIVE에 별도 연결 설정 저장.
- 라이선스: MIT. 저작권·사용 조건은 `licenses/streamrecord-port-LICENSE.txt`에 보존.
