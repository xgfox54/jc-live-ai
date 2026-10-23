# whisper-rs-sys 출처와 수정

- 원본: crates.io whisper-rs-sys 0.11.1. Cargo 캐시의 배포 소스 복사본.
- 원본 패키지 SHA-256: 76bab42b2c319e3a1e0280137c59368072348d3277873c7588b6466a127dca58. 기존 Cargo.lock의 checksum과 캐시 패키지 해시 일치 확인.
- 내장 whisper.cpp: 1.7.1. 기존 API·모델·추론 설정 유지.
- 수정: 모델 로더에서 ttype이 음수이거나 GGML_TYPE_COUNT 이상이면 로딩 거부.
- 공식 수정: https://github.com/ggml-org/whisper.cpp/commit/60c0be6ac8fa71b1a2ae2dd938a31a34a508e774
- 위 수정의 whisper_model_load 범위 검사만 이전 버전에 적용. 해당 버전에 없는 parakeet·VAD 모델 로더 변경은 적용 대상 아님.
- 원본 라이선스: whisper.cpp/LICENSE.

Cargo.toml의 patch.crates-io로 이 소스 사용. 공유 Cargo 캐시를 직접 수정하지 않음. 실행 파일은 별도 빌드 후 교체 필요.
