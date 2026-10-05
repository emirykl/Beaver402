import React, { useEffect, useRef, useState } from "react";

import { fetchConfig, type PublicConfig } from "./stellar-ops.js";
import { trackClick, trackView, type Link } from "./track.js";
import "./landing.css";

const REPOSITORY = "https://github.com/emirykl/Beaver402";
const DEMO = "https://youtu.be/0vFrfGZc1x0";
const doc = (path: string) => `${REPOSITORY}/blob/main/${path}`;

/** An outbound link that is counted when followed. */
function Out({
  href,
  link,
  className,
  children,
}: {
  href: string;
  link: Link;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a href={href} className={className} target="_blank" rel="noreferrer" onClick={() => trackClick("/", link)}>
      {children}
    </a>
  );
}

export function Nav({ current }: { current: "/" | "/status" }) {
  return (
    <nav className="site-nav" aria-label="Site">
      <a className="brand" href="/">
        <img src="/beaver402-logo.png" alt="" />
        <span>BEAVER402</span>
      </a>
      {current !== "/status" && (
        <a className="nav-link" href="/status" onClick={() => trackClick("/", "status")}>
          STATUS
        </a>
      )}
      {current !== "/" && (
        <a className="nav-link" href="/">
          HOME
        </a>
      )}
      <a className="nav-link" href={REPOSITORY} target="_blank" rel="noreferrer" onClick={() => trackClick(current, "repository")}>
        CODE
      </a>
      <a className="nav-link" href="/panel" onClick={() => trackClick(current, "panel")}>
        OWNER
      </a>
    </nav>
  );
}

/** Mark elements as seen once they scroll into view, so CSS can animate them in. */
function useReveal(deps: unknown[]) {
  useEffect(() => {
    const targets = document.querySelectorAll(".ld-reveal, .ld-statement, .ld-flow");
    if (!("IntersectionObserver" in window)) {
      targets.forEach((el) => el.classList.add("in"));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("in");
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.2, rootMargin: "0px 0px -8% 0px" }
    );
    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** A number that counts up from zero the first time it is seen. */
function CountUp({ to, unit }: { to: number; unit: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [value, setValue] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (still || !("IntersectionObserver" in window)) {
      setValue(to);
      return;
    }
    let frame = 0;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observer.disconnect();
        const start = performance.now();
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / 1400);
          setValue(Math.round(to * (1 - Math.pow(1 - t, 4))));
          if (t < 1) frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      },
      { threshold: 0.6 }
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [to]);

  return (
    <span className="ld-value" ref={ref}>
      {value}
      <span className="ld-unit">{unit}</span>
    </span>
  );
}

/** A sentence whose words light up one after another. */
function Statement({ words, accent }: { words: string; accent: string[] }) {
  return (
    <p className="ld-statement">
      {words.split(" ").map((word, i) => (
        <span
          key={i}
          className={accent.includes(word.replace(/[.,]/g, "")) ? "ld-word ld-accent" : "ld-word"}
          style={{ transitionDelay: `${i * 70}ms` }}
        >
          {word}{" "}
        </span>
      ))}
    </p>
  );
}

const icon = {
  signature: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19c2.5 0 3-6 5-6s1 4 3 4 2-3 3.5-3S18 16 20 16" />
      <path d="M14.5 4.5l5 5L11 18H6v-5z" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
      <path d="M8.5 11l1.8 1.8L13.8 9.3" />
    </svg>
  ),
  shield: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z" />
      <path d="M9 12l2.2 2.2L15.5 10" />
    </svg>
  ),
  bolt: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2.5L4.5 13.5H12l-1 8 8.5-11H12z" />
    </svg>
  ),
  pause: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M10 9v6M14 9v6" />
    </svg>
  ),
  key: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l8.5-8.5M16 7l2.5 2.5M18.5 4.5L21 7" />
      <path d="M3 3l18 18" opacity="0.55" />
    </svg>
  ),
  store: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 10v10h16V10M3 5h18l-1.5 5h-15z" />
      <path d="M9.5 20v-5h5v5" />
    </svg>
  ),
  down: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 6h16M7 12h10M10 18h4" />
    </svg>
  ),
  vault: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 8.8V7M12 17v-1.8M15.2 12H17M7 12h1.8" />
    </svg>
  ),
  lock: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
      <path d="M8.5 10.5V7.5a3.5 3.5 0 017 0v3" />
    </svg>
  ),
};

export default function Landing() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    trackView("/");
    fetchConfig().then(setConfig);
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useReveal([config]);

  const contractUrl = config?.contractId ? `${config.explorer}/contract/${config.contractId}` : null;
  const onMainnet = config?.network === "mainnet";
  const onSolana = config?.chains?.includes("solana") ?? false;

  return (
    <div className="ld">
      <nav className={scrolled ? "ld-nav scrolled" : "ld-nav"} aria-label="Site">
        <div className="ld-nav-inner">
          <a className="ld-brand" href="/">
            <img src="/beaver402-mark.png" alt="" />
            <span>Beaver402</span>
          </a>
          <a className="ld-link" href="#how">
            How it works
          </a>
          <a className="ld-link" href="#evidence">
            Evidence
          </a>
          <a className="ld-link" href="/status" onClick={() => trackClick("/", "status")}>
            Status
          </a>
          <a className="ld-link" href={REPOSITORY} target="_blank" rel="noreferrer" onClick={() => trackClick("/", "repository")}>
            Code
          </a>
          <a className="ld-cta" href="/panel" onClick={() => trackClick("/", "panel")}>
            Owner panel
          </a>
        </div>
      </nav>

      <main>
        <header className="ld-hero">
          <div className="ld-glow" aria-hidden="true" />
          <img className="ld-logo" src="/beaver402-mark.png" alt="Beaver402, a beaver holding a shield" />
          <span className="ld-chip">
            <span className="ld-dot" aria-hidden="true" />
            {onMainnet ? "Live on Stellar mainnet · limited pilot" : "Running on Stellar testnet"}
          </span>
          <h1>
            <span className="ld-line">Your agent pays.</span>
            <span className="ld-line ld-gradient">Only what you approved.</span>
          </h1>
          <p className="ld-sub">
            A smart account for AI agents that pay with x402. <strong>The merchant and the agent must agree on the
            exact payment</strong>, your limits always hold, and your passkey has the last word.
          </p>
          <div className="ld-actions">
            <a className="ld-button" href="/status" onClick={() => trackClick("/", "status")}>
              See it live
            </a>
            <Out className="ld-more" href={DEMO} link="demo">
              Watch the demo
            </Out>
          </div>
          <span className="ld-scroll" aria-hidden="true" />
        </header>

        <section className="ld-section" aria-label="The risk">
          <Statement
            words="A valid payment is not the same as an approved one."
            accent={["approved", "one"]}
          />
          <p className="ld-lead ld-center ld-reveal" style={{ textAlign: "center", marginLeft: "auto", marginRight: "auto" }}>
            A rewritten request, a manipulated prompt or a retry loop can all produce payments that look perfectly
            valid. Beaver402 refuses every one nobody agreed to.
          </p>
        </section>

        <section className="ld-section ld-center" id="how" aria-labelledby="how-title">
          <p className="ld-eyebrow ld-reveal">How it works</p>
          <h2 className="ld-title ld-reveal" id="how-title" style={{ ["--ld-delay" as string]: "0.08s" }}>
            Two signatures. One payment.
          </h2>
          <div className="ld-flow">
            {[
              { i: icon.signature, t: "Merchant signs", d: "The exact request, price and recipient." },
              { i: icon.check, t: "Agent checks", d: "Signs only what it really sent." },
              { i: icon.shield, t: "Account decides", d: "Rebuilds it on chain. Refuses any difference." },
              { i: icon.bolt, t: "Payment settles", d: "On the ledger, with a public proof of intent." },
            ].map((step, n) => (
              <div className="ld-step ld-reveal" key={step.t} style={{ ["--ld-delay" as string]: `${0.15 * n}s` }}>
                <div className="ld-step-icon">{step.i}</div>
                <h3>{step.t}</h3>
                <p>{step.d}</p>
              </div>
            ))}
          </div>
          <p className="ld-reveal" style={{ marginTop: 48 }}>
            <Out className="ld-more" href={doc("docs/threat-model.md")} link="threat-model">
              What it defends against
            </Out>
          </p>
        </section>

        <section className="ld-section ld-center" aria-labelledby="limits-title">
          <p className="ld-eyebrow ld-reveal">Limits</p>
          <h2 className="ld-title ld-reveal" id="limits-title" style={{ ["--ld-delay" as string]: "0.08s" }}>
            Real money. Deliberately little.
          </h2>
          <div className="ld-numbers">
            <div className="ld-number ld-reveal">
              <CountUp to={1} unit="USDC" />
              <p className="ld-label">per payment, at most</p>
            </div>
            <div className="ld-number ld-reveal" style={{ ["--ld-delay" as string]: "0.12s" }}>
              <CountUp to={5} unit="payments" />
              <p className="ld-label">in any 24 hours</p>
            </div>
            <div className="ld-number ld-reveal" style={{ ["--ld-delay" as string]: "0.24s" }}>
              <CountUp to={5} unit="USDC" />
              <p className="ld-label">in any 24 hours</p>
            </div>
          </div>
          <p className="ld-note ld-reveal">
            {icon.lock}
            Limits only go down. Reaching one freezes the account.
          </p>
        </section>

        <section className="ld-section" aria-labelledby="owner-title">
          <div className="ld-center">
            <p className="ld-eyebrow ld-reveal">Owner control</p>
            <h2 className="ld-title ld-reveal" id="owner-title" style={{ ["--ld-delay" as string]: "0.08s" }}>
              Your passkey. Your rules.
            </h2>
          </div>
          <div className="ld-bento">
            <div className="ld-tile wide ld-reveal">
              <span className="ld-icon">{icon.pause}</span>
              <div>
                <h3>Stop everything at once.</h3>
                <p>Freeze every payment with a touch, and resume when you are ready.</p>
              </div>
            </div>
            <div className="ld-tile wide ld-reveal" style={{ ["--ld-delay" as string]: "0.1s" }}>
              <span className="ld-icon">{icon.key}</span>
              <div>
                <h3>Take the key away.</h3>
                <p>Revoke the agent instantly. Give it back when it is safe.</p>
              </div>
            </div>
            <div className="ld-tile ld-reveal">
              <span className="ld-icon">{icon.store}</span>
              <div>
                <h3>Choose who gets paid.</h3>
                <p>Only merchants you approved.</p>
              </div>
            </div>
            <div className="ld-tile ld-reveal" style={{ ["--ld-delay" as string]: "0.1s" }}>
              <span className="ld-icon">{icon.down}</span>
              <div>
                <h3>Tighten the limits.</h3>
                <p>Loosening is refused on chain.</p>
              </div>
            </div>
            <div className="ld-tile ld-reveal" style={{ ["--ld-delay" as string]: "0.2s" }}>
              <span className="ld-icon">{icon.vault}</span>
              <div>
                <h3>Recover the funds.</h3>
                <p>To the address fixed at creation.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="ld-section ld-center" aria-labelledby="chains-title">
          <p className="ld-eyebrow ld-reveal">Standard rails</p>
          <h2 className="ld-title ld-reveal" id="chains-title" style={{ ["--ld-delay" as string]: "0.08s" }}>
            x402, with one extra signature.
          </h2>
          <p className="ld-lead ld-reveal" style={{ ["--ld-delay" as string]: "0.16s" }}>
            Standard x402 payments in USDC. Every check runs inside the account itself, before anything settles.
          </p>
          <div className="ld-chains">
            <div className="ld-chain ld-reveal">
              <span className="ld-chain-mark stellar">S</span>
              <div style={{ textAlign: "left" }}>
                <strong>Stellar</strong>
                <span>{onMainnet ? "Mainnet pilot" : "Testnet"} · Soroban smart account</span>
              </div>
            </div>
            {onSolana && (
              <div className="ld-chain ld-reveal" style={{ ["--ld-delay" as string]: "0.12s" }}>
                <span className="ld-chain-mark solana">◎</span>
                <div style={{ textAlign: "left" }}>
                  <strong>Solana</strong>
                  <span>Devnet · Anchor program</span>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="ld-section" id="evidence" aria-labelledby="evidence-title">
          <div className="ld-center">
            <p className="ld-eyebrow ld-reveal">Evidence</p>
            <h2 className="ld-title ld-reveal" id="evidence-title" style={{ ["--ld-delay" as string]: "0.08s" }}>
              Don't trust us. Check.
            </h2>
          </div>
          <div className="ld-proofs">
            {contractUrl ? (
              <Out className="ld-proof ld-reveal" href={contractUrl} link="contract">
                <strong>The account</strong>
                <span className="ld-id">{config?.contractId}</span>
                <em>On the explorer</em>
              </Out>
            ) : (
              <div className="ld-proof ld-reveal">
                <strong>The account</strong>
                <span>Not deployed yet</span>
              </div>
            )}
            <a className="ld-proof ld-reveal" href="/status" onClick={() => trackClick("/", "status")} style={{ ["--ld-delay" as string]: "0.08s" }}>
              <strong>Live status</strong>
              <span>Limits, the window, recent transactions.</span>
              <em>Status</em>
            </a>
            <Out className="ld-proof ld-reveal" href={doc("docs/evidence.md")} link="evidence">
              <strong>Evidence index</strong>
              <span>Every claim and what proves it.</span>
              <em>Index</em>
            </Out>
            <Out className="ld-proof ld-reveal" href={doc("docs/mainnet/deployment-record.md")} link="deployment-record">
              <strong>Deployment record</strong>
              <span>Commit, artifact hash, every transaction.</span>
              <em>Record</em>
            </Out>
            <Out className="ld-proof ld-reveal" href={DEMO} link="demo">
              <strong>Demonstration</strong>
              <span>The whole flow in one take.</span>
              <em>Video</em>
            </Out>
            <Out className="ld-proof ld-reveal" href={doc("docs/known-limitations.md")} link="limitations">
              <strong>What it does not do</strong>
              <span>Every known limitation, in plain words.</span>
              <em>Limitations</em>
            </Out>
          </div>
        </section>

        <section className="ld-closing" aria-label="Get started">
          <img className="ld-reveal" src="/beaver402-mark.png" alt="" />
          <h2 className="ld-title ld-reveal" style={{ margin: "0 auto", ["--ld-delay" as string]: "0.08s" }}>
            Let your agent pay. Safely.
          </h2>
          <div className="ld-actions ld-reveal" style={{ ["--ld-delay" as string]: "0.16s" }}>
            <a className="ld-button" href="/panel" onClick={() => trackClick("/", "panel")}>
              Open the owner panel
            </a>
            <Out className="ld-more" href={REPOSITORY} link="repository">
              Read the code
            </Out>
          </div>
        </section>
      </main>

      <footer className="ld-footer">
        <span>Beaver402</span>
        <span>Supported by Stellar Community Fund Instawards, Stellar Türkiye</span>
        <a href={REPOSITORY} target="_blank" rel="noreferrer">
          MIT licensed
        </a>
      </footer>
    </div>
  );
}
