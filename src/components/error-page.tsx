import { Link, useLocation } from "@tanstack/react-router";
import { ArrowLeft, FileSearch, RotateCcw, ScrollText } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  motion,
  useMotionTemplate,
  useMotionValue,
  useSpring,
} from "motion/react";

type ErrorPageProps = {
  variant?: "not-found" | "error";
  error?: Error;
  reset?: () => void;
};

/**
 * "Notice of Defect" — a notarial-document-style error page that arrives
 * on screen like a stamped recorder's notice. Used for both 404 and runtime
 * errors via TanStack Router's defaultNotFoundComponent / defaultErrorComponent.
 */
export function ErrorPage({
  variant = "not-found",
  error,
  reset,
}: ErrorPageProps) {
  const isNotFound = variant === "not-found";
  const code = isNotFound ? "404" : "500";
  const formNumber = isNotFound ? "Form 7-B" : "Form 12-D";
  const eyebrow = isNotFound ? "Defect of Record" : "Recording Failure";
  const title = isNotFound
    ? "Instrument Not on Record"
    : "Title Defect Detected";
  const body = isNotFound
    ? "The page you requested could not be located in this register. The instrument may have been recorded under a different number, removed by amendment, or never filed in this jurisdiction."
    : "An unexpected condition prevented this filing from being read. The fault has been logged with the recorder. You may attempt the action again, or return to the dashboard.";

  return (
    <main className="relative flex min-h-svh items-center justify-center overflow-hidden px-4 py-16">
      <AmbientHalos />
      <FloatingDust />

      <article className="tk-doc-rise relative z-10 w-full max-w-[44rem]">
        <DocumentCard
          code={code}
          formNumber={formNumber}
          eyebrow={eyebrow}
          title={title}
          body={body}
          error={error}
          reset={reset}
          isNotFound={isNotFound}
        />
      </article>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────────
// The document
// ─────────────────────────────────────────────────────────────────────

function DocumentCard({
  code,
  formNumber,
  eyebrow,
  title,
  body,
  error,
  reset,
  isNotFound,
}: {
  code: string;
  formNumber: string;
  eyebrow: string;
  title: string;
  body: string;
  error?: Error;
  reset?: () => void;
  isNotFound: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);

  // Subtle 3D parallax: tilt the document toward the cursor like a lifted
  // page on a desk. Spring-damped so it has weight, doesn't feel artificial.
  // Decoration-only — switches off under prefers-reduced-motion.
  const tiltX = useMotionValue(0);
  const tiltY = useMotionValue(0);
  const springConfig = { stiffness: 120, damping: 18, mass: 0.9 };
  const springTiltX = useSpring(tiltX, springConfig);
  const springTiltY = useSpring(tiltY, springConfig);
  const transform = useMotionTemplate`perspective(1400px) rotateX(${springTiltX}deg) rotateY(${springTiltY}deg)`;

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const onMove = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / r.width;
      const dy = (e.clientY - (r.top + r.height / 2)) / r.height;
      tiltX.set(-dy * 2.4);
      tiltY.set(dx * 2.4);
    };
    const onLeave = () => {
      tiltX.set(0);
      tiltY.set(0);
    };
    window.addEventListener("mousemove", onMove);
    el.addEventListener("mouseleave", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      el.removeEventListener("mouseleave", onLeave);
    };
  }, [tiltX, tiltY]);

  return (
    <motion.div
      ref={cardRef}
      style={{ transform }}
      className="paper-grain relative overflow-hidden rounded-[1.75rem] border border-border/60 bg-card shadow-[0_38px_80px_-30px_rgba(64,35,63,0.4),0_18px_40px_-15px_rgba(64,35,63,0.18),0_2px_0_rgba(255,255,255,0.6)_inset]"
    >
      {/* Header — recorder identity + filing reference */}
      <DocumentHeader formNumber={formNumber} />

      {/* Body grid: seal | message */}
      <div className="grid grid-cols-1 gap-8 px-7 pt-8 pb-10 sm:grid-cols-[auto_1fr] sm:gap-10 sm:px-12 sm:pt-10 sm:pb-12">
        <NotarialSeal code={code} />

        <div className="min-w-0">
          <div className="inline-flex items-center gap-2 text-[10px] font-semibold tracking-[0.22em] text-[#b78625] uppercase">
            <span className="size-1 rounded-full bg-[#b78625] tk-soft-pulse" />
            {eyebrow}
          </div>
          <h1 className="font-display mt-2.5 text-[clamp(2.1rem,5vw,3rem)] leading-[1.04] font-semibold tracking-tight text-[#40233f]">
            {title}
          </h1>
          <div className="deckle mt-5 w-24" />
          <p className="mt-5 max-w-prose text-[15px] leading-[1.65] text-muted-foreground">
            {body}
          </p>

          {error?.message && (
            <details className="mt-5 group/err">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-semibold tracking-[0.18em] text-[#8a3942] uppercase select-none hover:text-[#b94f58]">
                <span className="size-1.5 rounded-full bg-[#b94f58] tk-soft-pulse" />
                Recorder's note
                <span className="ml-1 text-muted-foreground/60 transition group-open/err:rotate-90">
                  ›
                </span>
              </summary>
              <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-[#f1d6d9] bg-[#fdecee]/50 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-[#7a2932]">
                {error.message}
              </pre>
            </details>
          )}

          <ActionRow reset={reset} isNotFound={isNotFound} />
        </div>
      </div>

      {/* Footer — date, jurisdiction, signature */}
      <DocumentFooter />
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Header — recorder identity + struck-through filing reference
// ─────────────────────────────────────────────────────────────────────

function DocumentHeader({ formNumber }: { formNumber: string }) {
  const location = useLocation();
  const path = location.pathname || "/";

  // Build a filing reference out of what the user actually tried to load.
  // Make it look like a recorder's filing number: ALL-CAPS with hyphens,
  // suffixed with the rejection code "NF" (no filing).
  const filingRef = useMemo(() => {
    const sanitized = path
      .replace(/^\/+/, "")
      .replace(/[^a-zA-Z0-9/]+/g, "-")
      .replace(/\/+/g, "-")
      .toUpperCase()
      .slice(0, 28);
    const tail = sanitized || "INDEX";
    return `INV-${tail}-NF`;
  }, [path]);

  // Typewriter — the filing reference types itself out, then a cursor blinks.
  const typed = useTypewriter(filingRef, 22);

  return (
    <header className="grid grid-cols-1 gap-3 border-b border-border/40 px-7 pt-6 pb-5 sm:grid-cols-[1fr_auto] sm:px-12 sm:pt-7">
      <div className="flex items-center gap-3">
        <RecorderCrest />
        <div className="leading-tight">
          <div className="font-display text-base font-semibold tracking-tight text-[#40233f]">
            Title Hub Recorder
          </div>
          <div className="mt-0.5 text-[10px] font-medium tracking-[0.22em] text-muted-foreground uppercase">
            Office of the Registrar · {formNumber}
          </div>
        </div>
      </div>

      <div className="flex flex-col items-start sm:items-end">
        <div className="text-[10px] font-medium tracking-[0.22em] text-muted-foreground uppercase">
          Filing Reference
        </div>
        <div className="font-mono text-[12px] leading-snug tracking-wider tabular-nums text-[#40233f]">
          <span className="line-through decoration-[#b94f58] decoration-2 underline-offset-2 opacity-70">
            {typed}
          </span>
          <span className="tk-cursor-blink ml-0.5 inline-block h-3 w-[2px] translate-y-px bg-[#40233f] align-middle" />
        </div>
      </div>
    </header>
  );
}

// Tiny crest used in the header — a folded-corner page stamped with a star.
function RecorderCrest() {
  return (
    <svg
      viewBox="0 0 28 28"
      className="size-7 shrink-0"
      aria-hidden="true"
      fill="none"
    >
      <defs>
        <linearGradient id="crest-brass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f4d48f" />
          <stop offset="55%" stopColor="#b78625" />
          <stop offset="100%" stopColor="#8c6210" />
        </linearGradient>
      </defs>
      <path
        d="M5 3 H18 L23 8 V25 H5 Z"
        fill="#fffdfa"
        stroke="#40233f"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M18 3 V8 H23"
        fill="#f6e8d9"
        stroke="#40233f"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle
        cx="14"
        cy="17"
        r="5"
        fill="url(#crest-brass)"
        stroke="#8c6210"
        strokeWidth="0.6"
      />
      <path
        d="M14 13.5 L14.7 16 L17.3 16 L15.2 17.5 L16 20 L14 18.5 L12 20 L12.8 17.5 L10.7 16 L13.3 16 Z"
        fill="#40233f"
        opacity="0.85"
      />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Notarial seal — the showpiece. Brass disc, rotating dotted ring with
// embossed circular text, sheen sweep, and a wax halo.
// ─────────────────────────────────────────────────────────────────────

function NotarialSeal({ code }: { code: string }) {
  return (
    <div className="relative mx-auto size-36 shrink-0 select-none sm:mx-0">
      {/* Wax halo behind the disc */}
      <div
        aria-hidden="true"
        className="tk-halo-drift absolute -inset-3 -z-10 rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(89,49,87,0.22) 0%, rgba(89,49,87,0.08) 45%, transparent 72%)",
          filter: "blur(8px)",
        }}
      />

      <div className="tk-stamp-press relative size-full">
        {/* Outer rotating ring — circular text + dotted edge */}
        <svg
          viewBox="0 0 144 144"
          className="tk-seal-rotor absolute inset-0 size-full"
          aria-hidden="true"
        >
          <defs>
            <path
              id="seal-circle"
              d="M72,72 m-58,0 a58,58 0 1,1 116,0 a58,58 0 1,1 -116,0"
            />
          </defs>
          <circle
            cx="72"
            cy="72"
            r="64"
            fill="none"
            stroke="#b78625"
            strokeOpacity="0.35"
            strokeWidth="0.6"
          />
          <circle
            cx="72"
            cy="72"
            r="58"
            fill="none"
            stroke="#8c6210"
            strokeOpacity="0.55"
            strokeWidth="0.5"
            strokeDasharray="1.4 3"
          />
          <text
            fontFamily="'JetBrains Mono', ui-monospace, monospace"
            fontSize="6.6"
            fontWeight="600"
            fill="#7a5818"
            letterSpacing="2.6"
          >
            <textPath href="#seal-circle" startOffset="0">
              ★ TITLE HUB RECORDER ★ NOTARIAL SEAL ★ ANNO DOMINI ★
            </textPath>
          </text>
        </svg>

        {/* Brass disc */}
        <div className="tk-seal-disc brass-foil absolute inset-5 grid place-items-center overflow-hidden rounded-full shadow-[inset_0_0_20px_rgba(140,98,16,0.55),inset_0_2px_0_rgba(255,235,180,0.6),0_3px_8px_rgba(64,35,63,0.3)]">
          {/* Sheen sweep */}
          <div
            aria-hidden="true"
            className="tk-seal-sheen absolute inset-0"
            style={{
              background:
                "linear-gradient(115deg, transparent 28%, rgba(255,250,225,0.6) 48%, transparent 70%)",
            }}
          />
          {/* Inner double-ring */}
          <div className="absolute inset-2 rounded-full ring-1 ring-[#3a2906]/30" />
          <div className="absolute inset-3 rounded-full ring-[0.5px] ring-[#3a2906]/20" />

          {/* Embossed crest */}
          <div className="relative z-10 grid place-items-center text-center">
            <div className="text-[8px] font-bold tracking-[0.24em] text-[#3a2906] uppercase">
              Void
            </div>
            <div
              className="font-display text-[34px] leading-none font-bold text-[#3a2906]"
              style={{
                textShadow:
                  "0 1px 0 rgba(255,235,180,0.7), 0 -1px 0 rgba(58,41,6,0.45)",
              }}
            >
              {code}
            </div>
            <div className="mt-0.5 text-[7px] font-bold tracking-[0.28em] text-[#3a2906]/85 uppercase">
              of record
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Action row — return / re-attempt / browse files
// ─────────────────────────────────────────────────────────────────────

function ActionRow({
  reset,
  isNotFound,
}: {
  reset?: () => void;
  isNotFound: boolean;
}) {
  return (
    <div className="mt-7 flex flex-wrap items-center gap-2">
      <Link
        to="/"
        className="group/cta inline-flex items-center gap-2 rounded-xl bg-[#40233f] px-4 py-2.5 text-sm font-medium text-[#fffdfa] shadow-[0_8px_20px_-8px_rgba(64,35,63,0.55)] ring-1 ring-[#593157]/40 transition hover:bg-[#593157] active:translate-y-px"
      >
        <ArrowLeft className="size-4 transition group-hover/cta:-translate-x-0.5" />
        Return to dashboard
      </Link>

      {reset ? (
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2.5 text-sm font-medium text-[#40233f] transition hover:bg-[#fdf6e8] active:translate-y-px"
        >
          <RotateCcw className="size-3.5" />
          Re-attempt
        </button>
      ) : null}

      <Link
        to={isNotFound ? "/files" : "/queue"}
        className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 py-2.5 text-sm font-medium text-[#40233f] transition hover:bg-[#fdf6e8] active:translate-y-px"
      >
        {isNotFound ? (
          <FileSearch className="size-3.5" />
        ) : (
          <ScrollText className="size-3.5" />
        )}
        {isNotFound ? "Browse files" : "Open queue"}
      </Link>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Footer — live timestamp, jurisdiction stamp, drawn signature
// ─────────────────────────────────────────────────────────────────────

function DocumentFooter() {
  const now = useLiveClock();

  const dateStr = useMemo(
    () =>
      now.toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
    [now],
  );
  const timeStr = useMemo(
    () =>
      now.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }),
    [now],
  );

  return (
    <footer className="border-t border-dashed border-border/50 bg-[linear-gradient(180deg,transparent,rgba(64,35,63,0.025))] px-7 pt-5 pb-7 sm:px-12">
      <div className="flex flex-col items-start justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <div className="text-[10px] font-medium tracking-[0.22em] text-muted-foreground uppercase">
            Filed at
          </div>
          <div className="font-display text-sm leading-tight font-medium text-[#40233f]">
            {dateStr}
          </div>
          <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {timeStr} · Recorder's Office
          </div>
        </div>

        <div className="flex flex-col items-start sm:items-end">
          <div className="text-[10px] font-medium tracking-[0.22em] text-muted-foreground uppercase">
            Registrar
          </div>
          <SignatureSquiggle />
          <div className="-mt-1 font-mono text-[10px] tracking-wide text-[#40233f]/70">
            /s/ E. Marlowe, Recorder
          </div>
        </div>
      </div>
    </footer>
  );
}

function SignatureSquiggle() {
  return (
    <svg
      viewBox="0 0 200 38"
      className="h-9 w-44"
      aria-hidden="true"
      fill="none"
    >
      <path
        d="M6,24 C18,8 30,30 46,18 C60,8 72,4 90,16 C106,28 118,36 138,18 C152,6 168,4 178,18 C184,26 190,22 194,16"
        stroke="#40233f"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="tk-signature-draw"
      />
      <line
        x1="6"
        y1="32"
        x2="194"
        y2="32"
        stroke="#40233f"
        strokeOpacity="0.22"
        strokeWidth="0.6"
        strokeDasharray="2 3"
      />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Ambient background — radial wax/ink halos behind the document
// ─────────────────────────────────────────────────────────────────────

function AmbientHalos() {
  return (
    <>
      <div
        aria-hidden="true"
        className="tk-halo-drift pointer-events-none absolute -top-40 -left-32 size-[28rem] rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(115,64,112,0.18) 0%, rgba(115,64,112,0.05) 45%, transparent 75%)",
          filter: "blur(20px)",
        }}
      />
      <div
        aria-hidden="true"
        className="tk-halo-drift pointer-events-none absolute -right-32 -bottom-40 size-[32rem] rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(183,134,37,0.22) 0%, rgba(183,134,37,0.06) 45%, transparent 78%)",
          filter: "blur(24px)",
          animationDelay: "-3s",
        }}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Floating ink dust — small motes drifting upward in the background
// ─────────────────────────────────────────────────────────────────────

function FloatingDust() {
  // Static, deterministic constellation so SSR and client agree.
  const motes = useMemo(
    () =>
      Array.from({ length: 18 }, (_, i) => {
        const left = (i * 13.7 + 7) % 100;
        const top = (i * 23.1 + 11) % 100;
        const size = 2 + ((i * 5) % 4);
        const delay = (i * 0.55) % 6;
        const duration = 6 + ((i * 7) % 6);
        const tone =
          i % 3 === 0 ? "#b78625" : i % 3 === 1 ? "#593157" : "#c9652e";
        return { id: i, left, top, size, delay, duration, tone };
      }),
    [],
  );

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-0"
    >
      {motes.map((m) => (
        <span
          key={m.id}
          className="tk-dust absolute rounded-full"
          style={{
            left: `${m.left}%`,
            top: `${m.top}%`,
            width: `${m.size}px`,
            height: `${m.size}px`,
            background: m.tone,
            opacity: 0.35,
            animationDelay: `${m.delay}s`,
            animationDuration: `${m.duration}s`,
          }}
        />
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Hooks
// ─────────────────────────────────────────────────────────────────────

function useLiveClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function useTypewriter(text: string, msPerChar: number) {
  const [n, setN] = useState(0);
  useEffect(() => {
    setN(0);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setN(text.length);
      return;
    }
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      setN(i);
      if (i >= text.length) window.clearInterval(id);
    }, msPerChar);
    return () => window.clearInterval(id);
  }, [text, msPerChar]);
  return text.slice(0, n);
}
