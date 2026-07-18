import { ImageResponse } from "next/og";

export const alt = "Event Zeka — Belgrade events, happening now";
export const size = { height: 630, width: 1200 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "center",
          background:
            "radial-gradient(circle at 78% 18%, rgba(139,134,251,0.34), transparent 34%), linear-gradient(135deg, #050609 0%, #0B0D12 100%)",
          color: "#F7F8F8",
          display: "flex",
          height: "100%",
          justifyContent: "space-between",
          padding: "72px 84px",
          width: "100%",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 720 }}>
          <div
            style={{
              alignItems: "center",
              background: "#8B86FB",
              borderRadius: 999,
              color: "#080A17",
              display: "flex",
              fontSize: 30,
              fontWeight: 700,
              gap: 14,
              padding: "14px 26px",
              width: 250,
            }}
          >
            <svg height="34" viewBox="0 0 48 48" width="34">
              <ellipse cx="17.5" cy="13" fill="#080A17" rx="5" ry="11" transform="rotate(-16 17.5 13)" />
              <ellipse cx="30.5" cy="13" fill="#080A17" rx="5" ry="11" transform="rotate(16 30.5 13)" />
              <circle cx="24" cy="29" fill="#080A17" r="13" />
              <circle cx="19.25" cy="27" fill="#8B86FB" r="1.35" />
              <circle cx="28.75" cy="27" fill="#8B86FB" r="1.35" />
              <path d="M22 32.2c1.1 1.35 2.9 1.35 4 0" fill="none" stroke="#8B86FB" strokeLinecap="round" strokeWidth="1.8" />
            </svg>
            Event Zeka
          </div>
          <div style={{ display: "flex", flexDirection: "column", fontSize: 70, fontWeight: 760, letterSpacing: -3, lineHeight: 1.02 }}>
            <span>Belgrade events,</span>
            <span>happening now.</span>
          </div>
          <div style={{ color: "#B8BFCA", fontSize: 30, lineHeight: 1.35 }}>
            Nightlife, concerts, club nights, and culture — one hop away.
          </div>
        </div>
        <svg height="360" viewBox="0 0 360 420" width="310">
          <ellipse cx="115" cy="96" fill="#8B86FB" rx="38" ry="92" transform="rotate(-16 115 96)" />
          <ellipse cx="245" cy="96" fill="#8B86FB" rx="38" ry="92" transform="rotate(16 245 96)" />
          <circle cx="180" cy="265" fill="#8B86FB" r="142" />
          <circle cx="130" cy="245" fill="#080A17" r="14" />
          <circle cx="230" cy="245" fill="#080A17" r="14" />
          <path d="M158 302c12 16 32 16 44 0" fill="none" stroke="#080A17" strokeLinecap="round" strokeWidth="17" />
          <path d="m308 42 9 20 21 9-21 9-9 21-9-21-21-9 21-9 9-20Z" fill="#F7F8F8" />
        </svg>
      </div>
    ),
    size,
  );
}
