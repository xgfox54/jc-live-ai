# 실행 환경 준비

## GitLab 배포 범위

저장소에 소스·테스트·설정 예시·운영 안내 게시. GitLab CI에서 테스트와 보안 검사 수행, 소스 ZIP 생성 구성. GitLab Pages나 외부 실행 서버의 자동 배포 대상은 미설정.

애플리케이션은 상시 실행 Node.js 서버·SQLite·음원 수집 프로세스·GPU 전사 워커 필요. 정적 웹 호스팅만으로 실행 불가.

## Windows 실행 자산

| 항목 | 위치·조건 |
|---|---|
| Node.js | 24.18 이상 25 미만 |
| 전사 모델 | models/ggml-small-q5_1.bin |
| 전사 워커 | bin/jc-live-worker.exe |
| FFmpeg | bin/ffmpeg.exe |
| yt-dlp | bin/yt-dlp.exe |
| GPU | Vulkan 지원 드라이버 |
| 실행 설정 | config.example.json을 config.local.json으로 복사 |

모델·실행 파일은 별도 관리. 기존 승인된 JC-LIVE 실행 자산을 해당 위치에 복사하거나 신뢰하는 공식 배포 경로에서 준비. 기준 해시는 저장소의 ASSETS.json, yt-dlp 출처는 licenses/yt-dlp/provenance.json 참조. 다른 버전의 자산 사용 시 실제 실행 검증과 출처 기록 필요.

워커를 새로 빌드하는 경우 Rust·Cargo, Visual Studio C++ 빌드 환경, Vulkan SDK, LLVM·Clang 및 Ninja 준비.

~~~powershell
scripts/build-worker.ps1 -VisualStudioEnvironment '개발자 환경 배치 경로' -VulkanSdk 'Vulkan SDK 경로' -ClangDirectory 'LLVM bin 경로' -TargetDirectory "$PWD\.build\target"
Copy-Item '.build/target/release/jc-live-worker.exe' 'bin/jc-live-worker.exe'
~~~

각 경로는 설치한 개발 도구의 실제 경로로 지정.
Windows 경로 길이 제한에 걸리면 짧은 TargetDirectory 지정. 제공 빌드 스크립트는 UTF-8 컴파일 옵션 적용.

## 최초 실행

~~~powershell
Copy-Item config.example.json config.local.json
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-live.ps1
~~~

이미 설정이 있으면 복사 생략. 프로젝트 루트에서 시작하며, config.local.json의 모델·실행 파일 경로 확인. service.ready 출력 후 http://127.0.0.1:4320/ 접속.

관리자는 http://127.0.0.1:4320/admin 에서 data/access.secret의 adminToken 입력. 최초 실행 시 키 자동 생성. 키 파일·DB·녹음 파일을 GitLab 변수나 저장소에 복사하지 않음.

## 운영 동작

서버 시작 시 공식 YouTube 채널·의회 홈페이지의 신규 생방송 탐색 기본 활성화. 이전에 끈 설정은 SQLite에서 유지. 관리자 ‘신규 방송 자동 등록’ 메뉴에서 재개 가능. 회의록은 /minutes 에서 열람. 상세 동작은 [자동 등록·회의록 안내](AUTOMATION.md) 참조.

- 승인한 방송만 등록. 주소 방식은 자동 감지 선택 후 저장.
- 자동 감지는 30초 간격, 조회 실패 시 최대 5분 간격 재시도.
- 녹음 저장 한도 도달 또는 저장 오류는 자동 감지 중단 사유. 관리자 화면의 안내 확인 후 조치.
- 서버 중지·PC 절전·전원 종료 중에는 방송 감지 불가.
- 방송 주소를 변경할 때 수집 중지 후 등록. 등록·수정 내용은 이용자 화면에 실시간 반영.

## 업데이트·백업

정상 종료 후 설정과 data/ 백업, 소스 업데이트, 자동 테스트 실행 후 재시작. 기존 키와 DB를 새 실행 폴더로 옮기는 경우 접근 권한 보존. 운영 자료를 소스 압축파일에 추가하지 않음.

~~~powershell
node scripts/stop-live.mjs config.local.json
git pull --ff-only
npm test
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-live.ps1
~~~

로컬 변경이 있으면 pull 전에 변경 내용을 별도 보존·통합. 강제 덮어쓰기 금지.

## GitLab 검사·배포본

| 작업 | 결과 |
|---|---|
| node_tests | 자동 테스트 및 JUnit 결과 |
| SAST | GitLab 제공 소스 보안 검사 |
| secret_detection | GitLab 제공 비밀정보 탐지 |
| source_package | 커밋 기준 소스 ZIP 생성 |

소스 압축파일은 CI 작업의 Artifacts에서 다운로드. 모델·바이너리·GPU 실제 시험은 해당 실행 환경에서 별도 확인. CI 통과만으로 실방송 인식 정확도나 운영 성능을 확인한 것으로 보지 않음.

CI 템플릿 기준: [GitLab SAST](https://docs.gitlab.com/user/application_security/sast/), [비밀정보 탐지](https://docs.gitlab.com/user/application_security/secret_detection/pipeline/).
