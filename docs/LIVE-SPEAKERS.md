# 방송별 실시간 화자분리

JC-LIVE 웹서비스의 방송별 임시 화자 번호 제공 기능. 동시 입력 상한 8개, 입력별 화자 번호 범위 1~8. 전사 모델 1개와 화자분리 모델 1개를 공유하고 방송별 입력 버퍼·큐·화자 캐시 분리.

## 실행 환경과 설정

Windows x64, Node.js 24.18 이상 25 미만, Python 3.11 이상 필요. Python 외부 패키지 불필요. 기존 `bin/diarization`의 DLL·모델·이용 조건 파일 사용. `Nemotron-3-Diarization.q8_0.gguf` SHA-256은 `08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1`.

`config.local.json` 설정 항목:

```json
{
  "liveDiarization": true,
  "diarizationPython": "C:/Python314/python.exe",
  "diarizationDirectory": "bin/diarization",
  "diarizationChunkFrames": 64,
  "chunkSeconds": 10
}
```

Python 경로는 실행 PC에 맞게 지정. 기존 설정의 다른 항목과 인증 정보 유지. `liveDiarization`을 생략하거나 false로 지정하면 실시간 화자분리 비활성화. 모델 초기화 실패 시 서비스 시작 실패. 실행 중 화자분리 프로세스 실패 시 전사 계속, 해당 구간 화자 정보는 분석 불가로 표시하며 새 수집 시작 차단. 서비스 재시작으로 복구.

```powershell
node src/main.mjs config.local.json --manual
node scripts/stop-live.mjs config.local.json
```

`--manual`은 자동 방송 탐색·자동 수집·외부 게시를 시작하지 않는 로컬 실행 방식. 기존 운영 설정과 시험용 뉴스 입력을 섞지 않고 성능 시험은 별도 데이터베이스에 저장.

## 화자 번호와 표시 기준

- 방송·녹음 세션·연속 입력 구간별 임시 번호 사용. 다른 방송의 화자 1과 같은 사람이라는 의미 없음.
- 재연결·음성 누락·입력 구간 변경·서비스 재시작 시 새 화자 범위 생성. 연결 전후 같은 사람의 번호 유지 보장 없음.
- 모델은 최대 8개 출력 번호 제공. 8명을 넘는 실제 인원의 구분·실명 식별·의원 사진 연결 보장 없음.
- 분석 중·화자 미확인·화자 분석 불가를 구분. 여러 화자가 포함된 구간은 번호 목록과 ‘구간 내 교대·겹침’으로 표시.
- 음성의 화자 구간 시각은 저장하되, 현재 전사문 시각은 10초 처리 구간 단위. 구간 내 여러 사람의 문장을 정밀하게 나누거나 단어마다 발언자를 확정하는 기능은 미구현.
- 이용자에게는 AI 후보정이 적용된 문장만 제공. 화자 분석 완료만으로 전사 원문을 공개하지 않음. 관리자 수동 지정과 후보정·수정 이력 보존.

## 시험 명령

프로젝트 루트에서 실행. 뉴스 탐색은 사용자가 승인한 뉴스 생방송 시험에 사용. 새 시험 시 방송 종료·주소 변경 여부 재확인 필요.

```powershell
node scripts/find-news-live.mjs reports/live-diarization-20261021
node scripts/bench-live-diarization.mjs 600 reports/live-diarization-20261021/live-new --chunk 10 --diar-chunk 64
node scripts/bench-live-diarization.mjs 60 reports/live-diarization-20261021/capacity-new --replay reports/live-diarization-20261021/live-new/result.json --capacity --chunk 10 --diar-chunk 64
node scripts/check-speaker-isolation.mjs reports/live-diarization-20261021/live-new/result.json reports/live-diarization-20261021/isolation-new
node scripts/qa-diarization-native.mjs reports/live-diarization-20261021/native-fault-new
npm test
npm run build:web
```

최대 처리능력 시험은 저장 음원을 수신 속도 제한 없이 처리하고, 실시간 시험은 실제 방송 수신 속도를 유지. 두 시험의 결과를 같은 의미로 해석하지 않음. 시험 범위는 전사·화자분리이며 AI 후보정 생성·300명 접속·정밀 영상 동기화·2시간 지속 시험은 별도 검증 대상. 사람 검토 정답이 없으면 화자분리 오류율과 전사 정확도는 미측정으로 기록.

시험 종료 후 수신 프로세스 중지, 남은 큐 처리, 화자 캐시 마무리, 모델 프로세스 종료 순서로 정리. 강제 종료 시 저장된 문장과 원음 보존, 다음 시작에서 중단 구간 기록. 원음·시험 데이터베이스·로그는 `reports/`에 로컬 저장하며 공개 웹 자산에 포함하지 않음.

## 네이티브 인터페이스 근거

[고정 리비전 C API](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/4c101bc7113f49101a3e11d2c994c519f41939f6/include/nemo_speech/diar.h), [화자 캐시 설정](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/4c101bc7113f49101a3e11d2c994c519f41939f6/src/asr/diar/aosc_state.h), [모델 카드](https://huggingface.co/nvidia/Nemotron-3-Diarization) 참조. `v3-streaming` 설정에서 중앙 구간 64프레임, 오른쪽 문맥 4프레임, 왼쪽 문맥 0프레임, FIFO 80프레임, 화자 캐시 264프레임, 갱신 주기 40프레임 적용. 1프레임은 80ms. 모델 가중치 공유, 입력별 독립 스트림 핸들 사용, 네이티브 계산은 직렬 실행.
