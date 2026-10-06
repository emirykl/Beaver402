import React, { useEffect, useRef, useState } from "react";

import { fetchConfig, type PublicConfig } from "./stellar-ops.js";
import { trackClick, trackView, type Link } from "./track.js";
import { GitHubMark, SolanaMark, StellarMark, XMark } from "./chain-logos.js";
import "./landing.css";

const REPOSITORY = "https://github.com/emirykl/Beaver402";
const DEMO = "https://youtu.be/0vFrfGZc1x0";
const X_ACCOUNT = "https://x.com/Beaver402";
const doc = (path: string) => `${REPOSITORY}/blob/main/${path}`;

/** An outbound link that is counted when followed. */
export function Out({
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

/** Mark elements as seen once they scroll into view, so CSS can animate them in. */
export function useReveal(deps: unknown[]) {
  useEffect(() => {
    const targets = document.querySelectorAll(".ld-reveal, .ld-statement, .ld-pipe, .ld-checks, .ld-device");
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
export function CountUp({ to, unit, decimals = 0 }: { to: number; unit: string; decimals?: number }) {
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
          const t = Math.min(1, (now - start) / 2000);
          setValue(to * (1 - Math.pow(1 - t, 3)));
          if (t < 1) frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      },
      { threshold: 0.5 }
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [to]);

  return (
    <span className="ld-value" ref={ref}>
      {value.toFixed(decimals)}
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

export const delay = (seconds: number) => ({ ["--ld-delay" as string]: `${seconds}s` }) as React.CSSProperties;

/** The parties a payment passes between, in order. */
const PIPE = ["Merchant", "Agent", "Beaver402", "Ledger"];

/** What the account checks before it lets a payment through, in the order it checks. */
const CHECKS = [
  "Account is active",
  "Agent key is yours",
  "Merchant is approved",
  "Merchant signed this request",
  "Terms match the signature",
  "Challenge is fresh",
  "Within your limits",
];

function Check() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 12.5l4 4L18 8" />
    </svg>
  );
}

function Fingerprint() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M12 11v3.5c0 2-.6 3.8-1.6 5.3" />
      <path d="M8.6 9.4A4 4 0 0116 11v2.6c0 2.6-.7 4.9-1.9 6.9" />
      <path d="M5.3 16.6c.5-1.3.7-2.6.7-4.1V11a6 6 0 0111.3-2.8" />
      <path d="M18 11.5v1c0 1.6-.2 3.2-.6 4.7" />
      <path d="M4 7.8A8.6 8.6 0 0118.7 5.3" />
      <path d="M8.9 20.4c.9-1.4 1.5-3 1.6-4.8" />
    </svg>
  );
}

/** The header every public page shares. It turns to glass once the page scrolls. */
export function SiteNav({ page }: { page: "/" | "/status" }) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav className={scrolled ? "ld-nav scrolled" : "ld-nav"} aria-label="Site">
      <div className="ld-nav-inner">
        <a className="ld-brand" href="/">
          <img src="/beaver402-mark.png" alt="" />
          <span>Beaver402</span>
        </a>
        {page === "/status" ? (
          <a className="ld-link" href="/">
            Home
          </a>
        ) : (
          <a className="ld-link" href="/status" onClick={() => trackClick(page, "status")}>
            Status
          </a>
        )}
        <a
          className="ld-link ld-icon-link"
          href={REPOSITORY}
          target="_blank"
          rel="noreferrer"
          aria-label="Source code on GitHub"
          title="GitHub"
          onClick={() => trackClick(page, "repository")}
        >
          <GitHubMark />
        </a>
        <a className="ld-cta" href="/panel" onClick={() => trackClick(page, "panel")}>
          Owner panel
        </a>
      </div>
    </nav>
  );
}

/** The footer card every public page shares. */
export function SiteFooter({ page = "/" }: { page?: "/" | "/status" }) {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  useEffect(() => {
    fetchConfig().then(setConfig);
  }, []);
  const contractUrl = config?.contractId ? `${config.explorer}/contract/${config.contractId}` : null;

  return (
    <footer className="ld-footer">
      <div className="ld-footer-card ld-reveal">
        <div className="ld-footer-brand">
          <img src="/beaver402-mark.png" alt="" />
          <strong>Beaver402</strong>
          <p>The payment security layer for AI agents.</p>
          <span className="ld-support">Supported by Stellar Community Fund Instawards and Stellar Türkiye</span>
        </div>
        <div className="ld-footer-cols">
          <div>
            <h4>Product</h4>
            <a href="/panel" onClick={() => trackClick(page, "panel")}>
              Owner panel
            </a>
            <a href="/status" onClick={() => trackClick(page, "status")}>
              Live status
            </a>
            <Out href={DEMO} link="demo">
              Demo video
            </Out>
            <a href={X_ACCOUNT} target="_blank" rel="noreferrer">
              X / Twitter
            </a>
          </div>
          <div>
            <h4>Proof</h4>
            <Out href={doc("docs/evidence.md")} link="evidence">
              Evidence index
            </Out>
            <Out href={doc("docs/mainnet/deployment-record.md")} link="deployment-record">
              Deployment record
            </Out>
            <Out href={doc("docs/threat-model.md")} link="threat-model">
              Threat model
            </Out>
            <Out href={doc("docs/known-limitations.md")} link="limitations">
              Known limitations
            </Out>
          </div>
          <div>
            <h4>Code</h4>
            <Out href={REPOSITORY} link="repository">
              GitHub
            </Out>
            {contractUrl ? (
              <Out href={contractUrl} link="contract">
                Contract on the explorer
              </Out>
            ) : null}
            <Out href={doc("docs/canonical-encoding.md")} link="encoding">
              What is signed
            </Out>
          </div>
        </div>
        <div className="ld-footer-bottom">
          <span>© 2026 Beaver402</span>
          <span>MIT licensed</span>
        </div>
      </div>
    </footer>
  );
}

export default function Landing() {
  const [config, setConfig] = useState<PublicConfig | null>(null);

  useEffect(() => {
    trackView("/");
    fetchConfig().then(setConfig);
  }, []);

  useReveal([config]);

  const contractUrl = config?.contractId ? `${config.explorer}/contract/${config.contractId}` : null;
  const onMainnet = config?.network === "mainnet";
  const onSolana = config?.chains?.includes("solana") ?? false;

  return (
    <div className="ld">
      <SiteNav page="/" />

      <main>
        <header className="ld-hero">
          <div className="ld-glow" aria-hidden="true" />
          <img className="ld-logo" src="/beaver402-mark.png" alt="Beaver402, a beaver holding a shield" />
          <p className="ld-kicker">AI Agent Payment Security Layer</p>
          <h1>
            <span className="ld-line">Your agent pays.</span>
            <span className="ld-line ld-gradient">Only what you approved.</span>
          </h1>
          <p className="ld-sub">
            Beaver402 sits between your AI agent and your money. Every x402 payment is checked on chain before a
            cent moves.
          </p>
        </header>

        <section className="ld-section" aria-label="The risk">
          <Statement words="A valid payment is not the same as an approved one." accent={["approved", "one"]} />
          <p className="ld-lead ld-reveal" style={{ textAlign: "center", marginLeft: "auto", marginRight: "auto" }}>
            A rewritten request, a manipulated prompt or a retry loop can all produce payments that look perfectly
            valid. Beaver402 refuses every one nobody agreed to.
          </p>
        </section>

        <section className="ld-section" id="how" aria-labelledby="how-title">
          <div className="ld-center">
            <p className="ld-eyebrow ld-reveal">How it works</p>
            <h2 className="ld-title ld-reveal" id="how-title" style={delay(0.08)}>
              Every payment, checked on chain.
            </h2>
          </div>

          <div className="ld-pipe" aria-label="The path of a payment">
            <div className="ld-pipe-track">
              <span className="ld-pipe-light" />
            </div>
            {PIPE.map((party, n) => (
              <div className={n === 2 ? "ld-pipe-node own" : "ld-pipe-node"} key={party} style={delay(0.2 + n * 0.18)}>
                <span className="ld-pipe-dot">{n === 2 ? <img src="/beaver402-mark.png" alt="" /> : null}</span>
                <span className="ld-pipe-name">{party}</span>
              </div>
            ))}
          </div>

          <div className="ld-flowbox">
            <div className="ld-request ld-reveal">
              <div className="ld-request-head">
                <span className="ld-request-badge">402</span>
                <span>Payment required</span>
              </div>
              <dl>
                <div>
                  <dt>Request</dt>
                  <dd>
                    <span className="ld-method">GET</span> /api/forecast
                  </dd>
                </div>
                <div>
                  <dt>Price</dt>
                  <dd>0.10 USDC</dd>
                </div>
                <div>
                  <dt>Pay to</dt>
                  <dd className="ld-mono">GBX4…7Q2M</dd>
                </div>
                <div>
                  <dt>Network</dt>
                  <dd>{onMainnet ? "Stellar mainnet" : "Stellar testnet"}</dd>
                </div>
              </dl>
              <div className="ld-request-sig">Signed by the merchant</div>
            </div>

            <ol className="ld-checks">
              {CHECKS.map((check, n) => (
                <li key={check} style={delay(0.3 + n * 0.2)}>
                  <span className="ld-tick">
                    <Check />
                  </span>
                  {check}
                </li>
              ))}
              <li className="ld-settled" style={delay(0.3 + CHECKS.length * 0.2)}>
                <span className="ld-tick">
                  <Check />
                </span>
                Paid
              </li>
            </ol>
          </div>
        </section>

        <section className="ld-section ld-center" aria-labelledby="limits-title">
          <p className="ld-eyebrow ld-reveal">Limits</p>
          <h2 className="ld-title ld-reveal" id="limits-title" style={delay(0.08)}>
            Real money. Deliberately little.
          </h2>
          <div className="ld-numbers">
            <div className="ld-number ld-reveal">
              <CountUp to={1} decimals={2} unit="USDC" />
              <p className="ld-label">per payment, at most</p>
            </div>
            <div className="ld-number ld-reveal" style={delay(0.12)}>
              <CountUp to={5} unit="payments" />
              <p className="ld-label">in any 24 hours</p>
            </div>
            <div className="ld-number ld-reveal" style={delay(0.24)}>
              <CountUp to={5} decimals={2} unit="USDC" />
              <p className="ld-label">in any 24 hours</p>
            </div>
          </div>
          <p className="ld-note ld-reveal">Limits only go down. Reaching one freezes the account.</p>
        </section>

        <section className="ld-section ld-owner" aria-labelledby="owner-title">
          <div className="ld-owner-text">
            <p className="ld-eyebrow ld-reveal">Owner control</p>
            <h2 className="ld-title ld-reveal" id="owner-title" style={delay(0.08)}>
              Your passkey. Your rules.
            </h2>
            <ul className="ld-powers">
              {[
                ["Freeze", "every payment at once, and resume when ready."],
                ["Revoke", "the agent's key, and give it back when safe."],
                ["Approve", "the only merchants that can be paid."],
                ["Lower", "any limit. Raising one is refused on chain."],
                ["Recover", "everything to the address fixed at creation."],
              ].map(([verb, rest], n) => (
                <li className="ld-reveal" key={verb} style={delay(0.1 + n * 0.08)}>
                  <strong>{verb}</strong> {rest}
                </li>
              ))}
            </ul>
          </div>

          <div className="ld-device" aria-hidden="true">
            <div className="ld-device-head">
              <img src="/beaver402-mark.png" alt="" />
              <div>
                <strong>Owner</strong>
                <span>Beaver402 account</span>
              </div>
            </div>
            <div className="ld-row">
              <span>Payments</span>
              <span className="ld-switch">
                <span />
              </span>
            </div>
            <div className="ld-row">
              <span>Agent key</span>
              <span className="ld-row-value">
                <span className="ld-mono">GA7Q…K2P</span>
                <span className="ld-pill">Revoke</span>
              </span>
            </div>
            <div className="ld-row">
              <span>Merchants</span>
              <span className="ld-row-value">
                <span className="ld-avatars">
                  <span />
                </span>
                1 approved
              </span>
            </div>
            <div className="ld-row ld-row-stack">
              <span className="ld-row-line">
                <span>Spent today</span>
                <span className="ld-row-value">1.40 / 5 USDC</span>
              </span>
              <span className="ld-bar">
                <span />
              </span>
            </div>
            <div className="ld-passkey">
              <span className="ld-print">
                <Fingerprint />
              </span>
              <span>Confirm with passkey</span>
            </div>
          </div>
        </section>

        <section className="ld-section ld-center" aria-labelledby="chains-title">
          <p className="ld-eyebrow ld-reveal">Standard rails</p>
          <h2 className="ld-title ld-reveal" id="chains-title" style={delay(0.08)}>
            x402, with one extra signature.
          </h2>
          <p className="ld-lead ld-reveal" style={delay(0.16)}>
            Standard x402 payments in USDC. Every check runs inside the account itself, before anything settles.
          </p>
          <div className="ld-chains">
            <div className="ld-chain ld-reveal">
              <StellarMark className="ld-chain-logo stellar" />
              <strong>Stellar</strong>
              <span>{onMainnet ? "Mainnet pilot" : "Testnet"} · Soroban smart account</span>
            </div>
            <div className="ld-chain-divider ld-reveal" style={delay(0.1)} />
            <div className="ld-chain ld-reveal" style={delay(0.2)}>
              <SolanaMark className="ld-chain-logo" />
              <strong>Solana</strong>
              <span>{onSolana ? "Devnet · Anchor program" : "Devnet · coming next"}</span>
            </div>
          </div>
        </section>

        <section className="ld-closing" aria-label="Get started">
          <img className="ld-reveal" src="/beaver402-mark.png" alt="" />
          <h2 className="ld-title ld-reveal" style={{ margin: "0 auto", ...delay(0.08) }}>
            Let your agent pay. Safely.
          </h2>
          <div className="ld-actions ld-reveal" style={delay(0.16)}>
            <a className="ld-social" href={X_ACCOUNT} target="_blank" rel="noreferrer">
              <XMark className="ld-social-icon" />
              Follow @Beaver402
            </a>
            <Out className="ld-social ld-social-play" href={DEMO} link="demo">
              <svg className="ld-social-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="currentColor" d="M8 5.5v13l11-6.5z" />
              </svg>
              Watch the demo
            </Out>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
