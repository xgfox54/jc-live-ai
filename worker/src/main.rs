use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Read, Write};
use std::time::Instant;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    pcm: String,
    prompt: String,
}

#[derive(Serialize)]
struct Span {
    start_ms: i64,
    end_ms: i64,
    text: String,
}

#[derive(Serialize)]
struct Reply {
    id: String,
    spans: Vec<Span>,
    inference_ms: u128,
    error: Option<String>,
}

fn transcribe(ctx: &WhisperContext, request: &Request, beam: i32) -> Result<Vec<Span>> {
    let bytes = STANDARD.decode(&request.pcm)?;
    if bytes.is_empty() || bytes.len() > 16_000 * 2 * 11 || bytes.len() % 2 != 0 {
        bail!("PCM must contain at most 11 seconds of mono 16 kHz s16le");
    }
    let audio: Vec<f32> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|v| f32::from(i16::from_le_bytes([v[0], v[1]])) / 32768.0)
        .collect();
    let mut params = FullParams::new(SamplingStrategy::BeamSearch {
        beam_size: beam,
        patience: 1.0,
    });
    params.set_language(Some("ko"));
    params.set_translate(false);
    params.set_no_context(true);
    params.set_n_threads(4);
    params.set_no_timestamps(true);
    params.set_token_timestamps(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_suppress_blank(true);
    params.set_suppress_non_speech_tokens(true);
    params.set_temperature(0.2);
    params.set_max_initial_ts(1.0);
    params.set_entropy_thold(2.4);
    params.set_logprob_thold(-1.0);
    params.set_no_speech_thold(0.55);
    params.set_max_len(200);
    params.set_split_on_word(true);
    let prompt: String = request
        .prompt
        .chars()
        .filter(|c| !c.is_control())
        .take(600)
        .collect();
    if !prompt.is_empty() {
        params.set_initial_prompt(&prompt);
    }
    let mut state = ctx.create_state()?;
    state.full(params, &audio)?;
    let mut spans = Vec::new();
    for index in 0..state.full_n_segments()? {
        spans.push(Span {
            start_ms: state.full_get_segment_t0(index)?.saturating_mul(10),
            end_ms: state.full_get_segment_t1(index)?.saturating_mul(10),
            text: state.full_get_segment_text_lossy(index)?,
        });
    }
    Ok(spans)
}

fn main() -> Result<()> {
    let model = std::env::args()
        .nth(1)
        .context("usage: worker MODEL [BEAM] [cpu|gpu]")?;
    let beam: i32 = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "2".into())
        .parse()?;
    if !(1..=8).contains(&beam) {
        bail!("beam must be 1..8");
    }
    let gpu = std::env::args().nth(3).unwrap_or_else(|| "gpu".into()) == "gpu";
    if gpu && !cfg!(any(feature = "vulkan", feature = "cuda")) {
        bail!("GPU build required");
    }
    let load_start = Instant::now();
    let options = WhisperContextParameters {
        use_gpu: gpu,
        ..Default::default()
    };
    let ctx = WhisperContext::new_with_params(&model, options)?;
    let load_ms = load_start.elapsed().as_millis();
    let warm_start = Instant::now();
    let warm = Request {
        id: "warmup".into(),
        pcm: STANDARD.encode(vec![0_u8; 32_000]),
        prompt: String::new(),
    };
    transcribe(&ctx, &warm, beam)?;
    let mut out = io::stdout().lock();
    writeln!(
        out,
        "{}",
        serde_json::json!({"ready":true,"load_ms":load_ms,
        "warmup_ms":warm_start.elapsed().as_millis(),"gpu_requested":gpu,"beam":beam,
        "engine":"whisper-rs-0.13.2","batch":1,"timestamp_quality":"chunk-envelope"})
    )?;
    out.flush()?;
    let mut input = io::stdin().lock();
    loop {
        let mut line = String::new();
        let size = (&mut input).take(600_001).read_line(&mut line)?;
        if size == 0 {
            break;
        }
        if size > 600_000 {
            bail!("request limit exceeded");
        }
        let request: Request = serde_json::from_str(&line)?;
        let start = Instant::now();
        let (spans, error) = match transcribe(&ctx, &request, beam) {
            Ok(spans) => (spans, None),
            Err(error) => (Vec::new(), Some(error.to_string())),
        };
        writeln!(
            out,
            "{}",
            serde_json::to_string(&Reply {
                id: request.id,
                spans,
                inference_ms: start.elapsed().as_millis(),
                error
            })?
        )?;
        out.flush()?;
    }
    Ok(())
}
