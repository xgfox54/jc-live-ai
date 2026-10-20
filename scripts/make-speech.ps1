param([string]$OutputDirectory = "data/synthetic-speech")
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$destination = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($destination) | Out-Null
$texts = @(
  '제주특별자치도의회 회의를 시작하겠습니다. 오늘은 지역 주민의 돌봄 서비스와 예산 집행 현황을 확인합니다. 지원 대상과 신청 절차를 담당 부서에서 설명해 주시기 바랍니다.',
  '교육위원회에서 학교 시설 개선 사업을 검토합니다. 학생 안전을 위한 통학로 정비 일정과 교실 환기 시설 점검 결과를 보고해 주십시오. 다음 달까지 보완 계획을 제출해 주시기 바랍니다.',
  '농수축경제위원회 회의입니다. 농산물 유통 비용과 어업인 지원 사업을 살펴보겠습니다. 지역 생산자 의견을 수렴하고 사업별 집행 금액을 확인하겠습니다.',
  '환경도시위원회에서는 대중교통 이용 편의 개선을 논의합니다. 버스 정류장 접근성과 보행자 안전 대책을 함께 검토하겠습니다. 주민 설명회 일정은 추후 공지합니다.',
  '행정자치위원회에서 민원 처리 절차를 점검합니다. 온라인 신청이 어려운 주민에게 방문 상담을 안내합니다. 담당자는 접수 일자와 처리 결과를 정확하게 기록해 주십시오.',
  '문화관광체육위원회 회의를 진행합니다. 공공 체육시설 운영 시간과 이용 요금을 확인합니다. 행사 안전관리 계획은 현장 점검 결과를 반영하여 작성해 주시기 바랍니다.',
  '보건복지안전위원회에서는 장애인 이동 지원을 검토합니다. 서비스 제공 기관의 역할과 이용자의 신청 방법을 설명합니다. 아직 확정되지 않은 사항은 검토 중이라고 표시합니다.',
  '예산결산특별위원회에서 사업별 결산 자료를 확인합니다. 총사업비와 실제 집행액을 구분하고 이월 사유를 설명해 주십시오. 자료에 없는 수치를 임의로 작성하지 않습니다.'
)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $synth.SelectVoice('Microsoft Heami Desktop')
  for ($index = 0; $index -lt $texts.Count; $index++) {
    $name = 'ch' + ($index + 1)
    $content = (($texts[$index] + ' ') * 5).Trim()
    $synth.SetOutputToWaveFile((Join-Path $destination ($name + '.wav')))
    $synth.Speak($content)
    $synth.SetOutputToNull()
    [IO.File]::WriteAllText((Join-Path $destination ($name + '.txt')), $content, [Text.UTF8Encoding]::new($false))
  }
} finally { $synth.Dispose() }
Write-Output ('Synthetic speech files: ' + $destination)
