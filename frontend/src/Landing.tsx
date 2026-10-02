import React, { useEffect, useState } from "react";

import { fetchConfig, type PublicConfig } from "./stellar-ops.js";
import { trackClick, trackView, type Link } from "./track.js";

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

export default function Landing() {
  const [config, setConfig] = useState<PublicConfig | null>(null);

  useEffect(() => {
    trackView("/");
    fetchConfig().then(setConfig);
  }, []);

  const contractUrl = config?.contractId ? `${config.explorer}/contract/${config.contractId}` : null;
  const onMainnet = config?.network === "mainnet";

  return (
    <div className="site">
      <Nav current="/" />
      <main className="site-main">
        <header className="hero">
          <span className="badge">{onMainnet ? "LIVE ON STELLAR MAINNET · LIMITED PILOT" : "STELLAR TESTNET"}</span>
          <h1>Your agent can only pay for what you approved.</h1>
          <p className="lead">
            Beaver402 is a Stellar smart account that settles an x402 payment only when the merchant and
            the buyer describe the same one, within limits the owner sets, under a passkey only the owner
            holds.
          </p>
          <div className="actions">
            <a className="action primary" href="/status" onClick={() => trackClick("/", "status")}>
              SEE IT LIVE
            </a>
            <a className="action" href="#evidence">
              CHECK THE EVIDENCE
            </a>
            <Out className="action" href={DEMO} link="demo">
              WATCH THE DEMO
            </Out>
          </div>
        </header>

        <section className="block" aria-labelledby="risk">
          <h2 id="risk">THE RISK</h2>
          <p className="claim">A valid payment is not the same as an approved one.</p>
          <p>
            x402 lets software pay for an API on its own: the server answers 402, the client pays, the
            server serves. When an agent holds the key, every payment the protocol accepts goes through. A
            manipulated prompt, a rewritten request or a retry loop can all produce payments that are
            perfectly valid and that nobody meant to make.
          </p>
        </section>

        <section className="block" aria-labelledby="how">
          <h2 id="how">HOW IT WORKS</h2>
          <p className="claim">Two parties have to describe the same payment before the account pays it.</p>
          <div className="steps">
            <div className="step">
              <strong>The merchant signs</strong>
              <span>
                Its 402 answer carries a challenge signed over the exact request: method, endpoint, query,
                body, price, recipient, token, network, a nonce and an expiry.
              </span>
            </div>
            <div className="step">
              <strong>The agent rebuilds it</strong>
              <span>
                The agent reconstructs the request from what it actually sent and refuses to sign anything
                that differs from what the merchant signed.
              </span>
            </div>
            <div className="step">
              <strong>The account decides</strong>
              <span>
                The smart account rebuilds the challenge on chain, checks the merchant is approved, the
                transfer is the agreed one, the nonce is new and the limits hold. Otherwise it refuses.
              </span>
            </div>
            <div className="step">
              <strong>The payment settles</strong>
              <span>
                A standard x402 facilitator settles the transfer. The merchant confirms it on the ledger,
                releases the resource and publishes the proof of intent.
              </span>
            </div>
          </div>
          <p>
            <Out href={doc("docs/canonical-encoding.md")} link="encoding">
              What exactly is signed
            </Out>{" "}
            ·{" "}
            <Out href={doc("docs/threat-model.md")} link="threat-model">
              What it defends against
            </Out>
          </p>
        </section>

        <section className="block" aria-labelledby="stellar">
          <h2 id="stellar">BUILT ON STELLAR AND X402</h2>
          <p className="claim">Standard rails, with one extra signature.</p>
          <p>
            Payments use the x402 v2 exact scheme on Stellar. The payer signs only a Soroban authorization
            entry; an existing facilitator builds the transaction, pays the network fee and submits it. USDC
            moves through its Stellar Asset Contract. The policy is a custom account contract, so every
            check runs inside the account's own <code>__check_auth</code>, before anything settles.{" "}
            <Out href={doc("docs/mainnet/x402-compat.md")} link="x402">
              How it fits the facilitator
            </Out>
          </p>
        </section>

        <section className="block" aria-labelledby="limits">
          <h2 id="limits">PILOT LIMITS</h2>
          <p className="claim">Real money, deliberately little of it.</p>
          <div className="facts">
            <div className="fact">
              <span className="value">1 USDC</span>
              <span className="label">most a single payment can move</span>
            </div>
            <div className="fact">
              <span className="value">5 payments</span>
              <span className="label">in any 24 hours</span>
            </div>
            <div className="fact">
              <span className="value">5 USDC</span>
              <span className="label">in any 24 hours</span>
            </div>
            <div className="fact">
              <span className="value">10 USDC</span>
              <span className="label">most the account ever holds</span>
            </div>
          </div>
          <p>
            Limits can only go down. The contract has no upgrade path, so nobody, not even the people who
            deployed it, can raise them. Reaching a limit freezes the account until the owner looks.
          </p>
        </section>

        <section className="block" aria-labelledby="owner">
          <h2 id="owner">THE OWNER STAYS IN CONTROL</h2>
          <p className="claim">One passkey, on the owner's device, overrides everything else.</p>
          <ul className="list">
            <li>
              <span className="name">Halt and resume</span>
              <span className="what">Stop every payment at once, and let them through again.</span>
            </li>
            <li>
              <span className="name">Revoke the agent</span>
              <span className="what">Take the agent's key away, and give it back when it is safe.</span>
            </li>
            <li>
              <span className="name">Choose the merchant</span>
              <span className="what">Only a merchant the owner approved can be paid at all.</span>
            </li>
            <li>
              <span className="name">Lower the limits</span>
              <span className="what">Tighten any limit. Loosening is refused by the contract.</span>
            </li>
            <li>
              <span className="name">Recover the funds</span>
              <span className="what">
                Send the whole balance to the recovery address fixed when the account was created.
              </span>
            </li>
          </ul>
          <p>
            <a href="/panel" onClick={() => trackClick("/", "panel")}>
              Open the owner panel
            </a>
          </p>
        </section>

        <section className="block" id="evidence" aria-labelledby="evidence-heading">
          <h2 id="evidence-heading">EVIDENCE</h2>
          <p className="claim">Every claim here can be checked without trusting us.</p>
          <ul className="list">
            <li>
              <span className="name">The account</span>
              <span className="what">
                {config?.contractId ? <span className="mono-id">{config.contractId}</span> : "Not deployed yet"}
              </span>
              {contractUrl && (
                <Out href={contractUrl} link="contract">
                  On the explorer
                </Out>
              )}
            </li>
            <li>
              <span className="name">Live status</span>
              <span className="what">Limits, what the window has used, recent transactions.</span>
              <a href="/status" onClick={() => trackClick("/", "status")}>
                Status
              </a>
            </li>
            <li>
              <span className="name">Deployment record</span>
              <span className="what">Source commit, artifact hash, parameters, every transaction.</span>
              <Out href={doc("docs/mainnet/deployment-record.md")} link="deployment-record">
                Record
              </Out>
            </li>
            <li>
              <span className="name">Evidence index</span>
              <span className="what">Each claim, and the transaction or test that proves it.</span>
              <Out href={doc("docs/evidence.md")} link="evidence">
                Index
              </Out>
            </li>
            <li>
              <span className="name">Demonstration</span>
              <span className="what">The whole flow, recorded in one take.</span>
              <Out href={DEMO} link="demo">
                Video
              </Out>
            </li>
            <li>
              <span className="name">Source</span>
              <span className="what">Contract, backend, panel, tests and documentation.</span>
              <Out href={REPOSITORY} link="repository">
                Repository
              </Out>
            </li>
          </ul>
        </section>

        <section className="block" aria-labelledby="limitations">
          <h2 id="limitations">WHAT IT DOES NOT DO</h2>
          <p>
            Whoever holds the owner's device is the owner; there is no recovery for a lost passkey yet. A
            compromised backend can spend up to the limits with an approved merchant, and the owner can stop
            it. Nothing judges whether a price is fair. The pilot works with one merchant, holds no one
            else's money, and has had a peer review rather than a formal audit.{" "}
            <Out href={doc("docs/known-limitations.md")} link="limitations">
              All known limitations
            </Out>
          </p>
        </section>
      </main>
      <footer className="site-footer">
        <span>Beaver402</span>
        <span>Supported by Stellar Community Fund Instawards, Stellar Türkiye</span>
        <a href={REPOSITORY} target="_blank" rel="noreferrer">
          MIT licensed
        </a>
      </footer>
    </div>
  );
}
