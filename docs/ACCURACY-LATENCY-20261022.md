# 전사 정확도 및 지연 재검증

작성일: 2026-10-22. 저장소: JC-LIVE-desktop-20261020-r1/JC-LIVE. 브랜치: work/desktop-feature-parity.

## 수정 내용

- `src/alt-engine.mjs`: 보조 인식 프로세스의 표준 입출력을 UTF-8로 고정. 기존 Windows CP949 출력과 Node UTF-8 해독의 불일치 해소.
- `test/alt-engine.test.mjs`: CP949 환경에서 실제 한국어 음성을 보조 인식기에 입력하는 회귀시험. 수정 전 문자 손상으로 실패, 수정 후 통과. 전체 시험 129개 통과.
- `scripts/latency/live8.mjs`: 파일 끝에 도달하면 해당 입력을 즉시 종료. 1초 음성을 1초 경과 후 투입. 지연 기준을 시험 시작 시각과 음성 위치로 계산. 기존 시험 DB 재사용 차단.
- `scripts/latency/export.mjs`: 최초 교정, 30초 시점 교정, 최종 교정 결과의 별도 내보내기. 일부 오류를 제외한 점수와 제외 전 문자 점수 구분.
- `scripts/latency/audit.mjs`: 읽기 전용 DB 감사. 지연, 보류 사유, 문자 손상, 방송 사이 화자 범위 공유 여부 기록.
- 기존 미커밋 실험 `scripts/accuracy/correct.mjs`, `scripts/accuracy/paragraph.mjs`, `src/correction-prompt.mjs` 보존. 문단 실험에 구간 배열 정렬 검사 추가. 실시간 서비스에는 문단 단계를 연결하지 않음.

## 기존 결과의 정정

`reports/latency/test8-final`은 8개 녹화 구간을 실제 속도로 최대 10분 투입한 시험임. 실제 생방송 수신 시험이 아님.

- 보조 인식 805건 중 800건에서 깨진 문자 발견. 이 결과만으로 정상 보조 인식의 효과를 판정할 수 없음.
- 기존 89.16%는 일부 경계 오류와 긴 삽입 등을 제외한 조정 문자 점수. 제외 전 문자 점수는 87.31%. 공백·문장부호 제거 등의 정규화 적용.
- 94.96%는 Sonnet 판정 모델이 의미를 바꾼 오류로 분류한 부분을 집계한 추정치. 사람이 원음을 확인한 정확도와 구분 필요.
- 기존 최대 17.02초는 enqueue 시각을 사용하여 파일 종료 전 버퍼 대기를 빠뜨린 값. 재생 시간축으로 재계산한 최대 지연은 약 93.48초. 구형 시험은 1초 음성을 tick 시작에 미리 투입하여 최대 1초의 시각 차이도 존재.
- 미공개 2건은 환각 문구 판정과 숫자 변경 검사에 따른 보류. 숫자 검사에는 `3도 1동`과 `삼도1동` 같은 지명 표기 차이도 걸림. 통과율을 높이기 위한 검사 해제는 하지 않음.

## 수정 후 재시험 결과

자료: `reports/latency/test8-utf8-r1/`. 18:08:26 KST부터 최대 10분간 저장 음원 8개를 실제 속도로 투입. 짧은 파일은 먼저 종료. 총 처리 음성 약 76.06분, 805개 구간.

| 항목 | 측정값 |
|---|---:|
| 최초 후보정문 평균 지연 | 10.42초 |
| 최초 후보정문 p95 / p99 | 12.87초 / 14.56초 |
| 최초 후보정문 최대 지연 | 15.94초 |
| 최초 공개 802건 중 15초 초과 | 4건 |
| 전체 805건 중 15초까지 공개 | 798건 |
| 최종 미공개 | 3건 |
| 입력 누락 / 전사 오류 / 보조 인식 오류 / 화자분리 오류 | 각각 0건 |
| 깨진 보조 인식 문장 | 0건 |
| 방송 세션 / 화자 범위 | 8개 / 8개 |
| 세션 사이 공유된 화자 범위 | 0개 |
| 30초 간격 관측 최대 작업 대기열 | 1개 |
| 30초 간격 관측 CPU 사용률 최대 | 77.9% |

미공개 3건의 사유: 숫자 변경 검사 2건, 환각 문구 필터 1건. 최초 후보정은 모두 응답을 받았으나 후속 정밀 후보정은 실패 2건, 검사 보류 30건. 최초 지연에는 청크 수집·작업 대기·인식·후보정과 파일 종료 시 버퍼 배출을 포함함. 15초를 넘은 4건에서는 인식 완료 후 후보정 대기가 각각 4.28~8.25초 발생.

| 평가 시점 | 제외 전 문자 점수 | 일부 차이를 제외한 조정 문자 점수 |
|---|---:|---:|
| 최초 공개 | 84.18% | 86.28% |
| 음성 시작 후 30초 | 87.87% | 89.74% |
| 후속 후보정 완료 후 | 88.50% | 90.35% |

두 문자 점수 모두 정규화한 공식 회의록과의 편집 거리에 기반한 `1-CER` 값이며 사람 검증 정확도와 다름. 이 결과로 정확도 95% 또는 모든 구간 15초 이내 처리를 달성했다고 판정하지 않음. 정밀 후보정으로 문장이 교체된 503건 중 30초 이내 교체 447건, 교체 최대 지연 51.52초.

최종 문장의 Sonnet 판정 의미 점수는 96.04%. 기준 18,822자, 의미 오류로 판정한 가중 문자 745자, 미판정 0자. 자동 판정 모델의 추정치이며 후속 교정 완료 후 결과임. 15초 시점 정확도 95%의 증거로 사용할 수 없음. 원자료는 `meaning.json` 및 `judge.log`.

운영 반영 상태: 소스 수정 및 별도 프로세스 검증 완료. 도구 실행 정책이 운영 서비스 재시작 명령을 실행 전에 차단함. 구체적인 차단 사유는 제공되지 않음. 기존 서비스 `/health/ready`는 계속 `ready: true`. 실행 중인 운영 프로세스에 이번 수정 반영은 미완료. 이번 작업의 커밋·원격 업로드·Vercel 배포 미실시.

## 모델 및 시험 조건

- GPU: NVIDIA GeForce RTX 4060, VRAM 8188 MiB. Node 24.18.0.
- 주 인식기: Whisper large-v3-turbo q8_0, CUDA worker 1개, beam 2, 청크 5~7초.
- 보조 인식기: SenseVoiceSmall 2024-07-17, CPU 4스레드. 방송별 화자분리 활성화.
- 최초 후보정: anthropic/claude-haiku-5-5. 후속 후보정: google-antigravity/gemini-3.8-flash.
- OpenCodex 로컬 프록시 이용. 프록시 뒤 모델 제공자에 대한 호출을 포함하므로 전체 AI 처리가 오프라인이라는 뜻은 아님.
- 제454회 공식 영상회의록의 저장 음원 8개 사용. 별도 시험 DB 사용. 시험 결과의 클라우드 게시 없음.
- 전체 원음과 사람이 검토한 전사문의 시간 정렬이 없음. 끝부분이 잘린 입력의 기준문은 시간 비율로 추정하므로 문자 점수에도 오차 가능.

## 문단 후보정 및 모델 선택

개발 자료의 문단 후보정 조정 문자 점수 85.49%, 모델 판정 의미 점수 약 94.9%. 호출 지연 평균 13.65초, p95 25.16초. 정확도 95%와 처리 지연 15초를 함께 입증하지 못하여 실시간 단계에 추가하지 않음.

SenseVoice 단독 비교 파일에는 문자 손상 없음. 기존 비교에서 Whisper보다 낮은 점수였으므로 주 전사 모델은 Whisper 유지. 상세 비교는 별도 experiment/sensevoice 브랜치의 `docs/STT-SENSEVOICE-EVAL.md`에 보존. 그 문서의 '글자 그대로 비교' 역시 제외 규칙이 적용된 점수이므로 정확 일치율로 해석하지 않음.

## 실행 명령

저장소 루트 PowerShell에서 실행. 결과 폴더는 매번 새 경로 지정.

```powershell
node scripts/latency/live8.mjs reports/accuracy/test reports/latency/test8-utf8-r1 10 model=anthropic/claude-haiku-5-5 refine=google-antigravity/gemini-3.8-flash alt=1 glossary=reports/accuracy/test-glossary.json worker=bin/cuda/jc-live-worker.exe workers=1 seg=5,7 hedge=3000
node scripts/latency/audit.mjs reports/latency/test8-utf8-r1 reports/latency/test8-utf8-r1/audit.json
node scripts/latency/export.mjs reports/accuracy/test reports/latency/test8-utf8-r1 reports/latency/test8-utf8-r1/final.json final
node scripts/latency/export.mjs reports/accuracy/test reports/latency/test8-utf8-r1 reports/latency/test8-utf8-r1/first.json first
node scripts/latency/export.mjs reports/accuracy/test reports/latency/test8-utf8-r1 reports/latency/test8-utf8-r1/view.json view
```

## 중지·복구·롤백

- 시험은 지정한 입력 시간 이후 버퍼를 배출하고 종료. 시험 DB와 운영 DB 분리.
- 운영 입력 중지는 관리자 화면에서 해당 입력만 선택. 재시작 전 수집·배출 중인 입력이 없는지 확인.
- 재시작 명령: `node src/main.mjs config.local.json`. 외부 동기화·자동 탐색을 시작하지 않는 수동 운영에는 `--manual` 추가.
- 이번 인코딩 변경의 롤백은 AltEngine 프로세스 생성 옵션에 추가한 `PYTHONIOENCODING` 설정만 제거한 뒤 재시작. 기존 미커밋 파일과 운영 DB를 전체 복원으로 덮어쓰지 않음.
- 시험 이전 원음·DB·보고서는 삭제하지 않음. 운영 설정 백업은 `reports/config.local.before-realtime-20261022.json` 및 `reports/config.local.before-alt-20261022.json`에 보존.

## 미실시 및 제한

이번 재시험에는 300명 웹 접속, 8개 입력과 300명 통합 접속, 2시간 유지, 공식 플레이어 30초 동기화, 사람이 검토한 원음 정답 비교를 포함하지 않음. 화자 범위의 방송 간 분리와 실제 화자 판별 정확도는 별개이며 후자는 미측정.
