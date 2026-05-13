"""
Marketing Studio — AI image generation service.

Two providers behind a uniform interface:

    "nano-banana"   → Gemini 3 Flash Image (gemini-3.1-flash-image-preview)
                      via emergentintegrations.llm.chat. Fast, ~£0.04/image,
                      excellent at burning text into banners.
    "gpt-image-1"   → OpenAI GPT Image 1 via
                      emergentintegrations.llm.openai.image_generation.
                      Slower, sharper composition, ~£0.10/image.

Both providers return PNG bytes at their native resolution. We
post-process with Pillow to crop+resize to the admin-specified
target (hero 1920×600, social 1080×1080, banner 1200×300, etc.) so
the storefront receives deterministic dimensions ready to drop in.

Cost tracking: every successful render writes a `marketing_assets`
document with `cost_usd` so the admin gallery surfaces lifetime spend.
"""
from __future__ import annotations

import io
import os
import base64
import logging
from typing import Optional

from PIL import Image, ImageOps

logger = logging.getLogger(__name__)

# Cost reference (USD, approximate). Updated whenever the providers
# change pricing — these flow into the admin gallery's "lifetime
# spend" counter, not customer-facing.
COST_USD = {
    "nano-banana": 0.04,
    "gpt-image-1": 0.10,
}

# Native sizes the providers tend to emit. We don't hand them an
# aspect-ratio kwarg (neither LlmChat.gemini nor OpenAIImageGeneration
# expose one); we always crop+resize after the fact.
PRESET_SIZES = {
    "hero": (1920, 640),
    "hero-tall": (1920, 720),
    "hero-wide-short": (1920, 600),
    "hero-square": (1080, 1080),
    "ribbon": (1200, 300),
    "social-square": (1080, 1080),
    "social-portrait": (1080, 1350),
    "social-landscape": (1200, 628),
    "lifestyle-product": (1024, 1024),
}


async def _generate_nano_banana(prompt: str, reference_image_b64: Optional[str] = None) -> bytes:
    """Call Gemini Nano Banana for a single image. Returns PNG bytes.

    `reference_image_b64` is an optional source image (PNG/JPG bytes
    base64-encoded) that the model uses as a style/material reference.
    For the lifestyle-from-tile flow we pass the tile catalogue photo
    here so the model knows what to put on the floor/wall."""
    from emergentintegrations.llm.chat import LlmChat, UserMessage, ImageContent

    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise RuntimeError("EMERGENT_LLM_KEY not set on backend")

    chat = LlmChat(
        api_key=api_key,
        session_id=f"marketing-studio-{os.urandom(4).hex()}",
        system_message="You are an expert commercial banner designer for a UK tile, bathroom and flooring retailer.",
    )
    chat.with_model("gemini", "gemini-3.1-flash-image-preview").with_params(modalities=["image", "text"])

    if reference_image_b64:
        msg = UserMessage(text=prompt, file_contents=[ImageContent(image_base64=reference_image_b64)])
    else:
        msg = UserMessage(text=prompt)
    _text, images = await chat.send_message_multimodal_response(msg)
    if not images:
        raise RuntimeError("Nano Banana returned no images — try a more specific prompt")
    return base64.b64decode(images[0]["data"])


async def _generate_gpt_image_1(prompt: str) -> bytes:
    """Call OpenAI GPT Image 1 for a single image. Returns PNG bytes."""
    from emergentintegrations.llm.openai.image_generation import OpenAIImageGeneration

    api_key = os.environ.get("EMERGENT_LLM_KEY")
    if not api_key:
        raise RuntimeError("EMERGENT_LLM_KEY not set on backend")

    gen = OpenAIImageGeneration(api_key=api_key)
    images = await gen.generate_images(
        prompt=prompt,
        model="gpt-image-1",
        number_of_images=1,
        quality="low",  # admin-facing draft tool — keep cheap
    )
    if not images:
        raise RuntimeError("GPT Image 1 returned no images")
    return images[0]


def _crop_resize_to_target(png_bytes: bytes, target_w: int, target_h: int) -> bytes:
    """Centre-crop the image to the target aspect ratio then resize to
    the exact pixel dimensions. ImageOps.fit does both in one shot.

    For ultra-wide banners (>2.5:1) generated from a near-square
    source, a naive vertical centre loses 70%+ of top/bottom. We shift
    centering slightly so more of the upper-centre (where AI models
    tend to place primary headlines) is preserved. The SAFE_ZONE_APPENDIX
    in the prompt puts text in the centre 50-55% y-band, so a slight
    upward centering (0.5, 0.45) keeps the whole text block on-screen.
    """
    img = Image.open(io.BytesIO(png_bytes))
    if img.mode != "RGB":
        img = img.convert("RGB")
    target_aspect = int(target_w) / max(1, int(target_h))
    source_aspect = img.width / max(1, img.height)
    # Default — true centre
    center_x, center_y = 0.5, 0.5
    # When the target is significantly WIDER than the source, most of
    # the top+bottom will be discarded. Bias slightly toward upper-
    # centre so the primary headline (which the safe-zone rules place
    # at y=45-55%) doesn't get trimmed.
    if target_aspect > 2.2 and source_aspect < 1.6:
        center_y = 0.47
    fitted = ImageOps.fit(
        img,
        (int(target_w), int(target_h)),
        method=Image.LANCZOS,
        centering=(center_x, center_y),
    )
    buf = io.BytesIO()
    fitted.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# Master safe-zone appendix added to every image-generation prompt so
# the model places headlines/CTAs/subtext within a predictable box
# that survives our downstream centre-crop to the banner aspect ratio.
# A recurring bug was text (e.g. "BANK HOLIDAY SALE") landing too
# close to the top edge of the 1024² source → when cropped to 3:1 the
# top half of the letters disappeared on the storefront. These rules
# prevent that regardless of the final banner aspect.
SAFE_ZONE_APPENDIX = (
    " SAFE ZONE RULES — ALL TEXT MUST OBEY THESE OR THE BANNER WILL BE REJECTED:"
    " (a) Every letter of every headline, subhead, offer, and CTA must sit inside the"
    " centre 60% of the frame — at least 20% padding from the top, bottom, left and right edges."
    " (b) Never place the primary headline in the top 25% or bottom 25% of the image."
    " (c) The CTA button must be fully inside the centre 50% of the frame."
    " (d) Treat the outer 15% of every edge as a BLEED ZONE that contains only background"
    " imagery (tiles, walls, props) — nothing with text, no logos, no buttons."
    " (e) Centre-align the text block vertically around the 45-55% y-band of the frame."
    " (f) Text must read top-to-bottom in a single column in the LEFT HALF of the frame;"
    " the RIGHT HALF shows the lifestyle/product imagery. This protects the text when the"
    " banner is downscaled for mobile."
    " (g) Use high contrast against the immediate background directly behind the letters."
)


def _aspect_directive(width: int, height: int) -> str:
    """Explicit aspect hint so the model emits an image shaped close to
    the target — reduces the amount of content the server-side crop
    has to discard."""
    aspect = width / max(1, height)
    if aspect >= 3.0:
        return " Output a very wide horizontal banner aspect (3:1 or wider). The frame is THREE TIMES wider than it is tall — design accordingly."
    if aspect > 2.0:
        return " Output a wide horizontal banner aspect (roughly 2:1 to 3:1). Emphasise horizontal composition."
    if aspect > 1.6:
        return " Output a standard widescreen banner aspect (16:9)."
    if aspect < 0.7:
        return " Output a tall vertical portrait aspect (roughly 9:16)."
    if 0.9 < aspect < 1.1:
        return " Output a square 1:1 aspect."
    return ""


async def generate_banner_image(
    prompt: str,
    model: str,
    width: int,
    height: int,
    enrichment_suffix: Optional[str] = None,
    reference_image_b64: Optional[str] = None,
) -> dict:
    """Single entry point used by the API layer.

    Returns a dict with `png_bytes`, `cost_usd`, `model`, `width`, `height`.
    The image is always cropped/resized to (width, height).
    `reference_image_b64` is only honoured by Nano Banana — GPT Image 1
    doesn't support reference images via the current SDK.
    """
    if model not in ("nano-banana", "gpt-image-1"):
        raise ValueError(f"Unsupported model: {model}")
    if width < 256 or height < 256 or width > 4096 or height > 4096:
        raise ValueError("Width and height must be between 256 and 4096 px")

    full_prompt = prompt.strip()
    if enrichment_suffix:
        full_prompt = f"{full_prompt} {enrichment_suffix}".strip()

    # Aspect hint — tells the model what shape to emit. Reduces the
    # amount of content we have to crop away after the fact.
    full_prompt += _aspect_directive(width, height)

    # Hard safe-zone rules so text never lands in a region that will
    # get chopped by the centre-crop downstream.
    full_prompt += SAFE_ZONE_APPENDIX

    if model == "nano-banana":
        raw_png = await _generate_nano_banana(full_prompt, reference_image_b64=reference_image_b64)
    else:
        # GPT Image 1 ignores reference for now — the prompt has to
        # describe the tile in words. Mention this in the playbook.
        raw_png = await _generate_gpt_image_1(full_prompt)

    out_png = _crop_resize_to_target(raw_png, width, height)
    return {
        "png_bytes": out_png,
        "cost_usd": COST_USD.get(model, 0.0),
        "model": model,
        "width": width,
        "height": height,
        "prompt": full_prompt,
    }
