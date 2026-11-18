"use client";

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { exportAvatar, openImage, type ExportBackground } from "../lib/avatar-images";
import { apiKeyLimit, hasApiKeyFormat, type AvatarAccess } from "../lib/avatar-credentials";

const examplePrompt = "Add a few faint freckles on both cheeks.";
const options = [
  { value: "transparent", label: "Transparent" },
  { value: "white", label: "White" },
] as const;
const themes = [
  { value: "blue", label: "Blue" },
  { value: "teal", label: "Teal" },
  { value: "red", label: "Red" },
] as const;
const photoTypes = ["image/png", "image/jpeg", "image/webp"];
const photoLimit = 8 * 1024 * 1024;
type Theme = typeof themes[number]["value"];
type Mode = "create" | "edit";
type Avatar = { source: string | Blob; alt: string; example?: "original" | "freckles" };
type Notice = { text: string; error?: boolean };

const original: Avatar = {
  source: "/assets/purple-boy-original.png",
  alt: "Full-body pixel boy with black hair, glasses and a purple T-shirt",
  example: "original",
};
const freckles: Avatar = {
  source: "/assets/purple-boy-freckles.png",
  alt: "Full-body pixel boy with glasses and light freckles on both cheeks",
  example: "freckles",
};
const pixelLetters: Record<string, string[]> = {
  P: ["11110","10001","10001","11110","10000","10000","10000"],
  I: ["11111","00100","00100","00100","00100","00100","11111"],
  X: ["10001","10001","01010","00100","01010","10001","10001"],
  E: ["11111","10000","10000","11110","10000","10000","11111"],
  L: ["10000","10000","10000","10000","10000","10000","11111"],
  M: ["10001","11011","10101","10101","10001","10001","10001"],
};

function Marquee() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    let left = 1;
    for (const letter of "PIXEL ME") {
      if (letter === " ") {
        left += 4;
        continue;
      }
      pixelLetters[letter].forEach((row, y) => {
        [...row].forEach((pixel, x) => {
          if (pixel !== "1") return;
          context.fillStyle = "#161725";
          context.fillRect(left + x, y + 2, 1, 1);
        });
      });
      pixelLetters[letter].forEach((row, y) => {
        [...row].forEach((pixel, x) => {
          if (pixel !== "1") return;
          context.fillStyle = y < 2 ? "#fff9df" : y < 5 ? "#ffecaa" : "#ffce51";
          context.fillRect(left + x, y + 1, 1, 1);
        });
      });
      left += 6;
    }
  }, []);

  return (
    <header className="marquee">
      <div className="marquee-face">
        <span className="marquee-spark" aria-hidden="true" />
        <h1><span className="sr-only">Pixel Me</span><canvas ref={canvas} width="48" height="10" aria-hidden="true" /></h1>
        <span className="marquee-spark" aria-hidden="true" />
      </div>
    </header>
  );
}

function useImageUrl(source: string | Blob | null) {
  const [object, setObject] = useState<{ source: Blob; url: string }>();
  useEffect(() => {
    if (!(source instanceof Blob)) return;
    const url = URL.createObjectURL(source);
    setObject({ source, url });
    return () => URL.revokeObjectURL(url);
  }, [source]);

  if (typeof source === "string") return source;
  return object?.source === source ? object?.url : undefined;
}

function normalizePrompt(prompt: string) {
  return prompt.trim().toLowerCase().replace(/[.!]+$/, "").replace(/\s+/g, " ");
}

export default function Arcade() {
  const [theme, setTheme] = useState<Theme>("blue");
  const [background, setBackground] = useState<ExportBackground>("transparent");
  const [customColor, setCustomColor] = useState("#80c7be");
  const [avatar, setAvatar] = useState<Avatar>(original);
  const [previous, setPrevious] = useState<Avatar | null>(null);
  const [showPrevious, setShowPrevious] = useState(false);
  const [mode, setMode] = useState<Mode>("edit");
  const [drafts, setDrafts] = useState({ create: "", edit: examplePrompt });
  const [photo, setPhoto] = useState<File | null>(null);
  const [siteAccess, setSiteAccess] = useState<AvatarAccess | null>();
  const [accessMethod, setAccessMethod] = useState<"chatgpt" | "api-key">("chatgpt");
  const [hasKey, setHasKey] = useState(false);
  const [keyError, setKeyError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>({
    text: "Press CREATE to try the freckle edit.",
  });
  const input = useRef<HTMLInputElement>(null);
  const promptBox = useRef<HTMLTextAreaElement>(null);
  const apiKey = useRef("");
  const accessDialog = useRef<HTMLDialogElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);
  const requestInProgress = useRef(false);
  const choosePhotoRequest = useRef(0);
  const displayed = showPrevious && previous ? previous : avatar;
  const avatarUrl = useImageUrl(displayed.source);
  const photoUrl = useImageUrl(photo);
  const canUseSiteKey = siteAccess?.enabled && siteAccess.signedIn;

  useEffect(() => {
    try {
      const stored = themes.find(option => option.value === localStorage.getItem("pixel-me-color"));
      if (stored) setTheme(stored.value);
    } catch {
      // The selector also works when browser storage is disabled.
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function checkAccess() {
      try {
        const response = await fetch("/api/avatar", {
          signal: controller.signal,
          cache: "no-store",
          redirect: "error",
        });
        if (!response.ok) throw new Error("Image access is unavailable.");
        const access = await response.json() as AvatarAccess;
        if (!controller.signal.aborted) setSiteAccess(access);
      } catch {
        if (!controller.signal.aborted) setSiteAccess(null);
      }
    }
    void checkAccess();
    return () => controller.abort();
  }, []);

  function changeTheme(value: Theme) {
    setTheme(value);
    try {
      localStorage.setItem("pixel-me-color", value);
    } catch {
      // This session can still use the selected color.
    }
  }

  function selectMode(next: Mode) {
    setMode(next);
    promptBox.current?.focus();
    setNotice({
      text: next === "edit"
        ? "Describe the change to the avatar shown here."
        : "Describe an avatar, add a photo, or use both.",
    });
  }

  async function choosePhoto(event: ChangeEvent<HTMLInputElement>) {
    const files = event.currentTarget.files;
    const file = files?.[0];
    const multipleFiles = (files?.length ?? 0) > 1;
    event.currentTarget.value = "";
    if (!file) return;
    const request = ++choosePhotoRequest.current;
    if (multipleFiles) {
      setNotice({ text: "Upload one reference photo at a time.", error: true });
      return;
    }
    if (!photoTypes.includes(file.type) || file.size > photoLimit || !file.size) {
      setNotice({ text: "Choose a JPG, PNG or WebP photo up to 8 MB.", error: true });
      return;
    }
    const url = URL.createObjectURL(file);
    try {
      await openImage(url);
      if (request !== choosePhotoRequest.current || requestInProgress.current) return;
      setPhoto(file);
      setMode("create");
      setNotice({ text: "Photo added. Press CREATE when ready." });
    } catch {
      if (request === choosePhotoRequest.current) {
        setNotice({ text: "This photo could not be opened. Try another image.", error: true });
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function loadExample() {
    setMode("edit");
    setDrafts(current => ({ ...current, edit: examplePrompt }));
    setAvatar(original);
    setPrevious(null);
    setShowPrevious(false);
    setNotice({ text: "Example loaded. Press CREATE to add freckles." });
  }

  function openAccessDialog() {
    setKeyError("");
    accessDialog.current?.showModal();
  }

  function useChatGPT() {
    setAccessMethod("chatgpt");
    accessDialog.current?.close();
    setNotice({ text: "Using this site's OpenAI API account." });
  }

  function saveKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = keyInput.current?.value.trim() || apiKey.current;
    if (!hasApiKeyFormat(value)) {
      setKeyError("Paste a complete OpenAI API key without spaces.");
      return;
    }
    apiKey.current = value;
    setHasKey(true);
    setAccessMethod("api-key");
    accessDialog.current?.close();
    setNotice({ text: "API key set for this tab. Press CREATE when ready." });
  }

  function clearKey() {
    apiKey.current = "";
    setHasKey(false);
    setAccessMethod("chatgpt");
    accessDialog.current?.close();
    setNotice({ text: "API key cleared." });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requestInProgress.current) return;
    const prompt = drafts[mode].trim();
    if (!prompt && (mode === "edit" || !photo)) {
      setNotice({ text: mode === "edit" ? "Describe what you want to change." : "Add a photo or describe your avatar.", error: true });
      promptBox.current?.focus();
      return;
    }

    if (displayed.example === "original" && mode === "edit" &&
        normalizePrompt(prompt) === normalizePrompt(examplePrompt)) {
      setPrevious(original);
      setAvatar(freckles);
      setShowPrevious(false);
      setNotice({ text: "Example applied. Compare the original and edited avatar." });
      return;
    }
    const key = accessMethod === "api-key" ? apiKey.current : "";
    if (!key && !canUseSiteKey) {
      setNotice({ text: "Choose an image access option to create an avatar." });
      openAccessDialog();
      return;
    }

    requestInProgress.current = true;
    setBusy(true);
    setNotice({ text: mode === "edit" ? "Editing your avatar…" : "Creating your avatar…" });
    try {
      const form = new FormData();
      form.set("mode", mode);
      form.set("prompt", prompt);
      if (mode === "edit") {
        let image = displayed.source;
        if (typeof image === "string") {
          const response = await fetch(image);
          if (!response.ok) throw new Error("The current avatar could not be loaded.");
          image = await response.blob();
        }
        form.set("image", image, "avatar.png");
      } else {
        if (photo) form.set("image", photo);
        const reference = await fetch("/assets/style-reference.png");
        if (!reference.ok) throw new Error("The pixel style reference could not be loaded.");
        form.set("style", await reference.blob(), "style-reference.png");
      }

      const response = await fetch("/api/avatar", {
        method: "POST",
        headers: key ? { Authorization: "Bearer " + key } : undefined,
        body: form,
        redirect: "error",
      });
      if (!response.ok || response.headers.get("content-type") !== "image/png") {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        if (!key && response.status === 401) {
          setSiteAccess(current => current ? { ...current, signedIn: false } : current);
          openAccessDialog();
        }
        throw new Error(result?.error ?? "The avatar could not be created. Please try again.");
      }
      const image = await response.blob();
      setPrevious(mode === "edit" ? displayed : null);
      setAvatar({ source: image, alt: mode === "edit" ? "Your edited pixel avatar" : "Your new pixel avatar" });
      setShowPrevious(false);
      setNotice({ text: mode === "edit" ? "Edit ready. Compare both versions before saving." : "Avatar ready. Choose a background and save it." });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : "The avatar could not be created.", error: true });
    } finally {
      setBusy(false);
      requestInProgress.current = false;
    }
  }

  async function save() {
    if (!avatarUrl || saving) return;
    setSaving(true);
    try {
      await exportAvatar(avatarUrl, background, customColor);
      setNotice({ text: "PNG downloaded." });
    } catch {
      setNotice({ text: "The PNG could not be saved. Please try again.", error: true });
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="workbench" data-theme={theme}>
      <div className="toolbar">
        <p><span aria-hidden="true" />Pixel avatar maker</p>
        <div className="toolbar-actions">
          <div className="cabinet-colors" role="group" aria-label="Cabinet color">
            <span className="color-title">Cabinet color</span>
            {themes.map(option => (
              <button type="button" key={option.value} className="theme-choice"
                data-choice={option.value} aria-pressed={theme === option.value}
                onClick={() => changeTheme(option.value)}>
                <span className="theme-dot" aria-hidden="true" />{option.label}
              </button>
            ))}
          </div>
          <button type="button" className="key-button" aria-haspopup="dialog" disabled={busy}
            onClick={openAccessDialog}>Image access</button>
        </div>
      </div>

      <dialog className="key-dialog" ref={accessDialog} aria-labelledby="access-title"
        onClose={() => { if (keyInput.current) keyInput.current.value = ""; }}>
        <div className="access-content">
          <h2 id="access-title">Image access</h2>
          <section className="chatgpt-access" aria-labelledby="chatgpt-title">
            <h3 id="chatgpt-title">ChatGPT</h3>
            {siteAccess === undefined && <p>Checking sign-in…</p>}
            {siteAccess === null && <p>ChatGPT access could not be checked. You can use your API key.</p>}
            {siteAccess && !siteAccess.signInPath && <p>Sign-in is available on the ChatGPT Sites version.</p>}
            {siteAccess?.signInPath && (
              <p>
                {siteAccess.signedIn && "Signed in with ChatGPT. "}
                {siteAccess.enabled
                  ? "Images use this site's OpenAI API account."
                  : "The site owner needs to set up image generation."}
              </p>
            )}
            {siteAccess?.signInPath && !siteAccess.signedIn && (
              <a className="chatgpt-action" href={siteAccess.signInPath} target="_top">Sign in with ChatGPT</a>
            )}
            {canUseSiteKey && (
              <button className="chatgpt-action" type="button" onClick={useChatGPT}
                disabled={accessMethod === "chatgpt"}>
                {accessMethod === "chatgpt" ? "Using ChatGPT" : "Use ChatGPT"}
              </button>
            )}
          </section>
          <form className="key-form" method="dialog" onSubmit={saveKey} autoComplete="off">
            <label htmlFor="pixel-api-key">Your OpenAI API key</label>
            <p id="key-hint">Use your own OpenAI API account. The key stays in this tab until you reload or close it.</p>
            <input id="pixel-api-key" ref={keyInput} type="password"
              placeholder={hasKey ? "Key saved in this tab" : "sk-…"}
              required={!hasKey} maxLength={apiKeyLimit} autoComplete="off" spellCheck={false}
              aria-describedby={keyError ? "key-hint key-error" : "key-hint"} />
            {keyError && <p id="key-error" className="key-error" role="alert">{keyError}</p>}
            <div className="key-actions">
              {hasKey && <button type="button" className="key-clear" onClick={clearKey}>Clear key</button>}
              <button type="button" onClick={() => accessDialog.current?.close()}>Cancel</button>
              <button type="submit" className="key-save">Use API key</button>
            </div>
          </form>
        </div>
      </dialog>

      <form className="cabinet" onSubmit={submit}>
        <Marquee />
        <div className="cabinet-body">
          <div className="bezel">
            <div className="crt">
              <section className="preview" aria-label="Avatar preview" aria-busy={busy}>
                <div className="stage" data-background={background}
                  style={background === "custom" ? { backgroundColor: customColor } : undefined}>
                  <span className="stage-label">{displayed.example ? "EXAMPLE" : "PREVIEW"}</span>
                  {avatarUrl && <img src={avatarUrl} alt={displayed.alt} draggable={false} />}
                  {previous && (
                    <div className="compare" role="group" aria-label="Compare avatar versions">
                      <button type="button" aria-pressed={showPrevious} disabled={busy} onClick={() => setShowPrevious(true)}>Before</button>
                      <button type="button" aria-pressed={!showPrevious} disabled={busy} onClick={() => setShowPrevious(false)}>After</button>
                    </div>
                  )}
                  {busy && (
                    <div className="stage-loading" aria-hidden="true">
                      <div className="stage-loading-panel">
                        {mode === "edit" ? "Editing…" : "Generating…"}
                        <span className="stage-loading-pixels" />
                      </div>
                    </div>
                  )}
                </div>
              </section>
              <div className="editor">
                <div className="prompt-header">
                  <label htmlFor="avatar-prompt">{mode === "edit" ? "Edit prompt" : "Prompt"}</label>
                  <button className="example-button" type="button" disabled={busy} onClick={loadExample}>Try example</button>
                </div>
                <textarea id="avatar-prompt" ref={promptBox} rows={4} maxLength={8000}
                  placeholder={mode === "edit" ? "What would you like to change?" : "Describe your avatar, from hair and clothes to accessories."}
                  value={drafts[mode]} disabled={busy}
                  onChange={event => setDrafts(current => ({ ...current, [mode]: event.target.value }))} />
                <input className="file-input" type="file" ref={input} accept=".jpg,.jpeg,.png,.webp"
                  aria-label="Reference photo" multiple={false} onChange={choosePhoto} />
                {photo && mode === "create" ? (
                  <div className="photo-chip">
                    {photoUrl && <img src={photoUrl} alt="" />}
                    <span title={photo.name}>{photo.name}</span>
                    <button type="button" disabled={busy} aria-label="Remove reference photo"
                      onClick={() => {
                        ++choosePhotoRequest.current;
                        setPhoto(null);
                        setNotice({ text: "Photo removed." });
                      }}>×</button>
                  </div>
                ) : (
                  <button className="photo-chip photo-chip-placeholder" type="button" disabled={busy}
                    onClick={() => input.current?.click()}>
                    <span className="photo-chip-plus" aria-hidden="true">+</span>
                    <span>Upload one photo</span>
                  </button>
                )}
                <fieldset className="backgrounds">
                  <legend>Export background</legend>
                  <div className="background-options">
                    {options.map(option => (
                      <button className="background-choice" type="button" key={option.value}
                        data-value={option.value} aria-pressed={background === option.value}
                        onClick={() => setBackground(option.value)}>
                        <span aria-hidden="true" />
                        {option.label}
                      </button>
                    ))}
                    <label className="background-choice custom-background" data-selected={background === "custom"}>
                      <span aria-hidden="true" style={{ backgroundColor: customColor }} />
                      Custom
                      <input type="color" value={customColor} aria-label="Custom background color"
                        onClick={() => setBackground("custom")}
                        onInput={event => {
                          setCustomColor(event.currentTarget.value);
                          setBackground("custom");
                        }} />
                    </label>
                  </div>
                </fieldset>
                <button className="save-button" type="button" onClick={save} disabled={saving || busy || !avatarUrl}>
                  <span className="download-icon" aria-hidden="true" />{saving ? "Saving…" : "Save PNG"}
                </button>
                <p className="notice" role="status" data-error={notice.error ? "true" : "false"}>{notice.text}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="control-deck">
          <div className="control-face">
            <div className="joystick" aria-hidden="true">
              <span className="joystick-base" /><span className="joystick-shaft" /><span className="joystick-ball" />
            </div>
            <button className="arcade-button" type="button" disabled={busy} onClick={() => input.current?.click()}>
              <span className="button-cap" aria-hidden="true" /><span>Upload</span>
            </button>
            <button className="arcade-button" type="button" disabled={busy} aria-pressed={mode === "create"}
              onClick={() => selectMode("create")}>
              <span className="button-cap" aria-hidden="true" /><span>Text</span>
            </button>
            <button className="arcade-button" type="button" disabled={busy} aria-pressed={mode === "edit"}
              onClick={() => selectMode("edit")}>
              <span className="button-cap" aria-hidden="true" /><span>Edit</span>
            </button>
            <button className="arcade-button primary" type="submit" disabled={busy}>
              <span className="button-cap" aria-hidden="true" /><span>{busy ? "Working…" : "Create"}</span>
            </button>
          </div>
        </div>
        <div className="kickplate" aria-hidden="true">
          <span className="vent" /><span className="coin-door"><i /></span><span className="vent" />
        </div>
        <div className="cabinet-feet" aria-hidden="true"><span /><span /></div>
      </form>
    </main>
  );
}
