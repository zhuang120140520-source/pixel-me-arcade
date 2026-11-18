import { env } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { hasApiKeyFormat, type AvatarAccess } from "../../../lib/avatar-credentials";
import { chatGPTSignInPath, getChatGPTUser } from "../../chatgpt-auth";

export const dynamic = "force-dynamic";

const imageLimit = 8 * 1024 * 1024;
const requestLimit = imageLimit * 2 + 64 * 1024;
const noStore = { "Cache-Control": "private, no-store" };
const mediaTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const imageApi = "https://api.openai.com/v1/images/edits";
const model = "gpt-image-2.5-sunburst";
const quotaErrors = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "billing_hard_limit_reached",
  "billing_not_active",
  "organization_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "project_spend_limit_exceeded",
]);

function fail(error: string, status: number) {
  return Response.json({ error }, { status, headers: noStore });
}

function supportsChatGPTSignIn(url: URL) {
  // ChatGPT Sites supplies identity headers at its hosted gateway.
  return url.protocol === "https:" && url.hostname.endsWith(".chatgpt.site");
}

export async function GET(request: Request) {
  const supportsSignIn = supportsChatGPTSignIn(new URL(request.url));
  const access: AvatarAccess = {
    enabled: supportsSignIn && Boolean(env.OPENAI_API_KEY),
    signedIn: supportsSignIn && Boolean(await getChatGPTUser()),
    signInPath: supportsSignIn ? chatGPTSignInPath("/") : null,
  };
  return Response.json(access, { headers: noStore });
}

function fileIsSupported(value: FormDataEntryValue | null): value is File {
  return value instanceof File && value.size > 0 && value.size <= imageLimit && mediaTypes.has(value.type);
}

async function imageReference(file: File) {
  const bytes = Buffer.from(await file.arrayBuffer());
  return { image_url: "data:" + file.type + ";base64," + bytes.toString("base64") };
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin !== url.origin) return fail("Open Pixel Me to create an avatar.", 403);

  const authorization = request.headers.get("authorization");
  let key: string;
  if (authorization !== null) {
    key = authorization.match(/^Bearer (.+)$/i)?.[1] ?? "";
    if (!hasApiKeyFormat(key)) return fail("Enter your OpenAI API key to create an avatar.", 401);
  } else {
    if (!supportsChatGPTSignIn(url)) return fail("Enter your OpenAI API key to create an avatar.", 401);
    if (!await getChatGPTUser()) return fail("Sign in with ChatGPT or enter your own OpenAI API key.", 401);
    key = env.OPENAI_API_KEY ?? "";
    if (!key) return fail("The site's image generation is awaiting setup. You can enter your own API key.", 503);
  }

  if (!request.headers.get("content-type")?.startsWith("multipart/form-data")) {
    return fail("Attach a photo or enter a prompt in Pixel Me.", 400);
  }
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > requestLimit) return fail("Choose a photo up to 8 MB.", 413);

  let fields: FormData;
  try {
    fields = await request.formData();
  } catch {
    return fail("The photo and prompt could not be read.", 400);
  }
  const mode = fields.get("mode");
  const description = fields.get("prompt");
  const photos = fields.getAll("image");
  if (photos.length > 1) return fail("Upload one reference photo at a time.", 400);
  const photo = photos[0] ?? null;
  const style = fields.get("style");
  if ((mode !== "edit" && mode !== "create") || typeof description !== "string" ||
      description.length > 8000 || (!description.trim() && (mode === "edit" || !photo))) {
    return fail("Add a photo or a shorter description.", 400);
  }
  if ((photo && !fileIsSupported(photo)) || (mode === "edit" && !fileIsSupported(photo))) {
    return fail("Choose a JPG, PNG or WebP image up to 8 MB.", 400);
  }
  if (mode === "create" && !fileIsSupported(style)) {
    return fail("The pixel style reference could not be loaded. Please try again.", 400);
  }

  try {
    const images = [];
    if (fileIsSupported(photo)) images.push(await imageReference(photo));
    if (mode === "create" && fileIsSupported(style)) images.push(await imageReference(style));
    const stylePrompt =
      "Make a full-body, front-facing chibi pixel avatar. Use a large head, short body, visible square pixels, a limited warm palette, and stepped outlines. Center one character with both shoes in frame and a clean transparent background. No letters, props outside the character, gradients, scenery or frames.";
    let prompt: string;
    if (mode === "edit") {
      prompt = "Edit the supplied pixel avatar. Make only the described change and preserve its identity, clothes, standing pose, pixel style and transparent background. Change requested: " + description.trim();
    } else {
      const references = photo
        ? " The first image supplies the person's appearance and clothing. Use the second image only for the pixel style and proportions."
        : " Use the reference only for the pixel style and proportions. Follow the description for the new character.";
      prompt = stylePrompt + references + " Character description: " + (description.trim() || "Use the appearance from the first image.");
    }

    const response = await fetch(imageApi, {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        images,
        prompt,
        size: "1024x1360",
        quality: "medium",
        background: "transparent",
        output_format: "png",
        n: 1,
      }),
      signal: AbortSignal.timeout(210_000),
      // Cloudflare Workers uses manual redirect handling to keep the key on the API origin.
      redirect: "manual",
    });
    if (authorization === null && [401, 403, 404].includes(response.status)) {
      return fail("The site's OpenAI API key is unavailable. You can use your own API key.", 503);
    }
    if (response.status === 401) return fail("OpenAI did not accept that API key. Check it under Image access.", 401);
    if (response.status === 403 || response.status === 404) {
      return fail("This API key may not have access to the image model.", 403);
    }
    if ([400, 402, 429].includes(response.status)) {
      const result = await response.json().catch(() => null) as { error?: { code?: string; type?: string } } | null;
      const { code = "", type = "" } = result?.error ?? {};
      if (quotaErrors.has(code) || quotaErrors.has(type)) {
        return fail("The OpenAI API project has a billing or usage limit issue. Check its credits and limits.", 402);
      }
    }
    if (response.status === 429) return fail("The image service is busy. Try again in a moment.", 429);
    if (response.status === 400) return fail("The image service could not use that input. Try another photo or description.", 400);
    if (!response.ok) return fail("The image service could not finish the request.", 502);
    const result = await response.json() as { data?: { b64_json?: string }[] };
    const png = result.data?.[0]?.b64_json;
    if (!png) return fail("The image service returned no avatar.", 502);
    const bytes = Uint8Array.from(Buffer.from(png, "base64"));
    return new Response(bytes, {
      headers: { ...noStore, "Content-Type": "image/png", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return fail("The image service did not respond. Please try again.", 502);
  }
}

