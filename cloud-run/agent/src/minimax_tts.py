"""
MiniMax TTS — 自訂 LiveKit TTS Plugin
繞過官方 plugin 的 voice_id 限制，支援自訂克隆聲紋

用法：
    from agent.minimax_tts import MiniMaxCustomTTS
    tts = MiniMaxCustomTTS(
        api_key="sk-...",
        group_id="20315...",
        voice_id="moss_audio_...",
    )
"""
import io
import logging
from dataclasses import dataclass

import aiohttp
from livekit.agents import tts

logger = logging.getLogger(__name__)

MINIMAX_API_URL = "https://api.minimax.io/v1/t2a_v2"


@dataclass
class MiniMaxTTSOptions:
    api_key: str
    group_id: str
    voice_id: str
    model: str = "speech-02-turbo"
    speed: float = 1.0
    vol: float = 1.0
    pitch: float = 0.0
    emotion: str = ""   # happy/sad/angry/fearful/disgusted/surprised/neutral；空字串 = API 自動推斷
    sample_rate: int = 24000


class MiniMaxCustomTTS(tts.TTS):
    """自訂 MiniMax TTS — 支援任意 voice_id（含自訂克隆聲紋）"""

    def __init__(
        self,
        *,
        api_key: str,
        group_id: str,
        voice_id: str,
        model: str = "speech-02-turbo",
        speed: float = 1.0,
        vol: float = 1.0,
        pitch: float = 0.0,
        emotion: str = "",
        sample_rate: int = 24000,
    ):
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=False),
            sample_rate=sample_rate,
            num_channels=1,
        )
        self._opts = MiniMaxTTSOptions(
            api_key=api_key,
            group_id=group_id,
            voice_id=voice_id,
            model=model,
            speed=speed,
            vol=vol,
            pitch=pitch,
            emotion=emotion,
            sample_rate=sample_rate,
        )
        self._session: aiohttp.ClientSession | None = None

    def _ensure_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            self._session = aiohttp.ClientSession()
        return self._session

    def synthesize(self, text: str, *, conn_options=None) -> "MiniMaxChunkedStream":
        return MiniMaxChunkedStream(
            tts=self,
            input_text=text,
            opts=self._opts,
            session=self._ensure_session(),
            conn_options=conn_options,
        )

    async def aclose(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()


class MiniMaxChunkedStream(tts.ChunkedStream):
    """MiniMax TTS chunked stream — 呼叫 REST API 取得 PCM 音訊"""

    def __init__(
        self,
        *,
        tts: MiniMaxCustomTTS,
        input_text: str,
        opts: MiniMaxTTSOptions,
        session: aiohttp.ClientSession,
        conn_options: "APIConnectOptions | None" = None,
    ):
        # livekit-agents 1.5.x 需要 conn_options 參數
        from livekit.agents import APIConnectOptions
        if conn_options is None:
            conn_options = APIConnectOptions()
        super().__init__(tts=tts, input_text=input_text, conn_options=conn_options)
        self._opts = opts
        self._session = session

    async def _run(self, output_emitter) -> None:
        """執行 TTS 合成，取得 PCM 音訊並發送 AudioFrame"""
        import uuid

        logger.info(f"MiniMax TTS text: {self._input_text[:200]!r}")
        url = f"{MINIMAX_API_URL}?GroupId={self._opts.group_id}"
        headers = {
            "Authorization": f"Bearer {self._opts.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "text": self._input_text,
            "model": self._opts.model,
            "stream": False,
            "voice_setting": {
                "voice_id": self._opts.voice_id,
                # 江彬 minimax_tts 原寫 int()，但 MiniMax API speed/vol 是 float（0.5-2.0），
                # 0.9 / 1.2 這種小數 cast 成 0/1 → 念太慢或不發聲。修正為 float。
                "speed": float(self._opts.speed),
                "vol": float(self._opts.vol),
                "pitch": int(self._opts.pitch),  # pitch 是 int (-12 ~ 12) 不變
                **( {"emotion": self._opts.emotion} if self._opts.emotion else {} ),
            },
            "audio_setting": {
                "sample_rate": int(self._opts.sample_rate),
                "format": "pcm",
            },
        }

        try:
            async with self._session.post(url, json=payload, headers=headers) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    logger.error(f"MiniMax TTS error {resp.status}: {error_text[:200]}")
                    return

                data = await resp.json()
                status_code = data.get("base_resp", {}).get("status_code", -1)

                if status_code != 0:
                    logger.error(f"MiniMax TTS API error: {data.get('base_resp', {})}")
                    return

                audio_hex = data.get("data", {}).get("audio", "")
                if not audio_hex:
                    logger.error("MiniMax TTS: no audio data in response")
                    return

                pcm_bytes = bytes.fromhex(audio_hex)

                # livekit-agents 1.5.x: 正確的 AudioEmitter 用法
                # 參考 ElevenLabs plugin: initialize → push → flush（沒有 start_segment/end_segment）
                from livekit.agents import utils
                output_emitter.initialize(
                    request_id=utils.shortuuid(),
                    sample_rate=self._opts.sample_rate,
                    num_channels=1,
                    mime_type="audio/pcm",
                )
                output_emitter.push(pcm_bytes)
                output_emitter.flush()
                logger.info(f"MiniMax TTS: synthesized {len(pcm_bytes)} bytes")

        except Exception as e:
            logger.error(f"MiniMax TTS request failed: {e}")
