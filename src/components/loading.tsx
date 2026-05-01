import { cn } from "@/lib/utils";

export type LoadingSize = "sm" | "md" | "lg";

type LoadingProps = {
  size?: LoadingSize;
  /** Italic serif label rendered beneath the seal. Trailing dots animate. */
  label?: string;
  /** Centered, padded block — for page- or panel-level fills. */
  block?: boolean;
  className?: string;
};

const SIZE_PX: Record<LoadingSize, number> = { sm: 22, md: 56, lg: 96 };

export function Loading({
  size = "md",
  label,
  block = false,
  className,
}: LoadingProps) {
  const px = SIZE_PX[size];
  const showRotor = size !== "sm";

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "tk-loading inline-flex flex-col items-center gap-3",
        block &&
          "flex min-h-[80svh] w-full flex-col items-center justify-center py-10",
        className,
      )}
    >
      <div className="relative isolate" style={{ width: px, height: px }}>
        {showRotor && <SealRotor />}
        <SealDisc px={px} />
      </div>
      {label ? (
        <p className="font-display text-sm tracking-wide text-[#40233f]/75 italic">
          {label}
          <span className="tk-dot" data-i="0">
            .
          </span>
          <span className="tk-dot" data-i="1">
            .
          </span>
          <span className="tk-dot" data-i="2">
            .
          </span>
        </p>
      ) : (
        <span className="sr-only">Loading</span>
      )}
    </div>
  );
}

function SealRotor() {
  // 60 tick marks, every 5th major — like the edge of a rotary notary stamp
  // or a surveyor's compass dial.
  const ticks = Array.from({ length: 60 }, (_, i) => i);
  return (
    <svg
      viewBox="0 0 100 100"
      className="tk-seal-rotor absolute inset-0"
      aria-hidden
    >
      <circle
        cx="50"
        cy="50"
        r="48"
        fill="none"
        stroke="#40233f"
        strokeOpacity="0.18"
        strokeWidth="0.6"
      />
      <circle
        cx="50"
        cy="50"
        r="40"
        fill="none"
        stroke="#40233f"
        strokeOpacity="0.1"
        strokeWidth="0.5"
      />
      {ticks.map((i) => {
        const major = i % 5 === 0;
        return (
          <line
            key={i}
            x1="50"
            y1={major ? 40.5 : 42.5}
            x2="50"
            y2={major ? 47.5 : 46}
            stroke="#40233f"
            strokeWidth={major ? 0.8 : 0.55}
            strokeOpacity={major ? 0.7 : 0.32}
            strokeLinecap="round"
            transform={`rotate(${i * 6} 50 50)`}
          />
        );
      })}
    </svg>
  );
}

function SealDisc({ px }: { px: number }) {
  const inset = px <= 26 ? "6%" : "26%";
  const showOrnament = px >= 44;
  return (
    <div
      className="tk-seal-disc absolute rounded-full"
      style={{
        inset,
        background:
          "radial-gradient(circle at 30% 26%, #f7e0a8 0%, #d6a447 38%, #b78625 64%, #8c6210 100%)",
        boxShadow:
          "inset 0 0 0 1px rgba(64,35,63,0.34), inset 0 1px 0 rgba(255,250,235,0.55), 0 1px 1px rgba(64,35,63,0.18), 0 6px 16px -6px rgba(64,35,63,0.45)",
      }}
    >
      <span
        aria-hidden
        className="tk-seal-sheen absolute inset-0 rounded-full"
        style={{
          background:
            "conic-gradient(from 220deg, transparent 0deg, rgba(255,253,247,0.7) 28deg, transparent 78deg, transparent 360deg)",
          mixBlendMode: "soft-light",
        }}
      />
      <span
        aria-hidden
        className="absolute rounded-full"
        style={{
          inset: "14%",
          boxShadow:
            "inset 0 0 0 1px rgba(64,35,63,0.42), inset 0 0 6px rgba(64,35,63,0.18)",
        }}
      />
      {showOrnament && (
        <span
          aria-hidden
          className="font-display absolute inset-0 grid place-items-center leading-none font-semibold text-[#40233f]"
          style={{
            fontSize: `${Math.round(px * 0.34)}px`,
            textShadow: "0 1px 0 rgba(255,253,247,0.6)",
          }}
        >
          ❦
        </span>
      )}
    </div>
  );
}
