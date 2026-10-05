//! A policy account on a LiteSVM ledger, with an owner passkey, an agent, a
//! merchant, a recipient and a recovery address, and helpers that build
//! payments and owner actions the way the backend will.
#![allow(dead_code)]

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use openssl::bn::BigNumContext;
use openssl::ec::{EcGroup, EcKey, PointConversionForm};
use openssl::nid::Nid;
use openssl::pkey::Private;
use solana_account::Account;
use solana_clock::Clock;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_associated_token_account_interface::address::get_associated_token_address;
use spl_token_interface::state::{Account as TokenAccount, AccountState, Mint};

use beaver402_policy::constants::{CHALLENGE_DOMAIN, POLICY_SEED};
use beaver402_policy::encoding::{domain_separated_hash, settlement_preimage, Settlement};
use beaver402_policy::owner::{base64url_encode, challenge, OwnerProof};
use beaver402_policy::state::{Policy, VelocityConfig};
use beaver402_policy::{InitializeArgs, PayArgs};

pub const START: i64 = 1_700_000_000;
pub const DEVNET: &str = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
pub const RP_ID: &str = "beaver402.test";

/// 1 USDC per payment, 5 payments and 5 USDC in any 24 hours, with 6
/// decimals: the pilot limits.
pub fn pilot_limits() -> VelocityConfig {
    VelocityConfig {
        max_payment_amount: 1_000_000,
        max_tx_count: 5,
        max_total_amount: 5_000_000,
        window_size: 86_400,
    }
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    solana_sha256_hasher::hash(data).to_bytes()
}

pub struct Passkey {
    key: EcKey<Private>,
    pub compressed: [u8; 33],
}

impl Passkey {
    pub fn new() -> Self {
        let group = EcGroup::from_curve_name(Nid::X9_62_PRIME256V1).unwrap();
        let key = EcKey::generate(&group).unwrap();
        let mut ctx = BigNumContext::new().unwrap();
        let bytes = key
            .public_key()
            .to_bytes(&group, PointConversionForm::COMPRESSED, &mut ctx)
            .unwrap();
        Self {
            key,
            compressed: bytes.try_into().unwrap(),
        }
    }

    pub fn sign(&self, message: &[u8]) -> [u8; 64] {
        let der = self.key.private_key_to_der().unwrap();
        solana_secp256r1_program::sign_message(message, &der).unwrap()
    }
}

/// How an assertion is put together, so tests can break one part at a time.
pub struct Assertion {
    pub rp_id: String,
    pub flags: u8,
    pub kind: String,
    /// Overrides the challenge the assertion carries.
    pub challenge: Option<[u8; 32]>,
    pub valid_until: Option<u64>,
}

impl Default for Assertion {
    fn default() -> Self {
        Self {
            rp_id: RP_ID.to_string(),
            flags: 0x05,
            kind: "webauthn.get".to_string(),
            challenge: None,
            valid_until: None,
        }
    }
}

/// The terms of a payment, so tests can change one at a time.
#[derive(Clone)]
pub struct Terms {
    pub request_digest: [u8; 32],
    pub recipient: Pubkey,
    pub amount: u64,
    pub nonce: [u8; 32],
    pub expiry: u64,
    pub network: String,
}

pub struct Env {
    pub svm: LiteSVM,
    pub payer: Keypair,
    pub agent: Keypair,
    pub merchant: Keypair,
    pub recipient: Keypair,
    pub recovery: Keypair,
    pub owner: Passkey,
    pub mint: Pubkey,
    pub policy_id: [u8; 32],
    pub policy: Pubkey,
    pub vault: Pubkey,
    pub nonce_counter: u8,
}

pub fn program_id() -> Pubkey {
    beaver402_policy::ID
}

fn so_path() -> String {
    format!(
        "{}/../../target/deploy/beaver402_policy.so",
        env!("CARGO_MANIFEST_DIR")
    )
}

pub fn token_account(mint: Pubkey, owner: Pubkey, amount: u64) -> Vec<u8> {
    let mut data = vec![0u8; TokenAccount::LEN];
    TokenAccount {
        mint,
        owner,
        amount,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    }
    .pack_into_slice(&mut data);
    data
}

impl Env {
    /// A fresh ledger with a policy account holding 10 USDC and the merchant
    /// already approved.
    pub fn new() -> Self {
        Self::with_limits(pilot_limits())
    }

    pub fn with_limits(limits: VelocityConfig) -> Self {
        let mut env = Self::bare();
        env.initialize(limits).expect("initialize");
        env.fund_vault(10_000_000);
        env.owner_action("add_merchant", Some(env.merchant.pubkey()), None, Assertion::default())
            .expect("approve merchant");
        env
    }

    /// A ledger with the program, a mint and the token accounts, but no
    /// policy account yet.
    pub fn bare() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(program_id(), so_path())
            .expect("run anchor build first");
        let payer = Keypair::new();
        svm.airdrop(&payer.pubkey(), 100_000_000_000).unwrap();

        let mut clock: Clock = svm.get_sysvar();
        clock.unix_timestamp = START;
        svm.set_sysvar(&clock);

        let mint = Pubkey::new_unique();
        let mut data = vec![0u8; Mint::LEN];
        Mint {
            mint_authority: COption::Some(payer.pubkey()),
            supply: 1_000_000_000_000,
            decimals: 6,
            is_initialized: true,
            freeze_authority: COption::None,
        }
        .pack_into_slice(&mut data);
        svm.set_account(
            mint,
            Account {
                lamports: svm.minimum_balance_for_rent_exemption(Mint::LEN),
                data,
                owner: spl_token_interface::ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();

        let policy_id = sha256(b"beaver402 test policy");
        let policy = Pubkey::find_program_address(&[POLICY_SEED, &policy_id], &program_id()).0;
        let vault = get_associated_token_address(&policy, &mint);

        let mut env = Self {
            svm,
            payer,
            agent: Keypair::new(),
            merchant: Keypair::new(),
            recipient: Keypair::new(),
            recovery: Keypair::new(),
            owner: Passkey::new(),
            mint,
            policy_id,
            policy,
            vault,
            nonce_counter: 0,
        };
        let recipient = env.recipient.pubkey();
        let recovery = env.recovery.pubkey();
        env.create_token_account(recipient, 0);
        env.create_token_account(recovery, 0);
        env
    }

    pub fn create_token_account(&mut self, owner: Pubkey, amount: u64) -> Pubkey {
        let address = get_associated_token_address(&owner, &self.mint);
        self.svm
            .set_account(
                address,
                Account {
                    lamports: self.svm.minimum_balance_for_rent_exemption(TokenAccount::LEN),
                    data: token_account(self.mint, owner, amount),
                    owner: spl_token_interface::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        address
    }

    pub fn initialize_args(&self, velocity: VelocityConfig) -> InitializeArgs {
        InitializeArgs {
            policy_id: self.policy_id,
            owner: self.owner.compressed,
            rp_id_hash: sha256(RP_ID.as_bytes()),
            network_id: sha256(DEVNET.as_bytes()),
            agent_signer: self.agent.pubkey(),
            recovery: self.recovery.pubkey(),
            velocity,
        }
    }

    pub fn initialize(&mut self, velocity: VelocityConfig) -> Result<(), String> {
        let args = self.initialize_args(velocity);
        self.initialize_with(args)
    }

    pub fn initialize_with(&mut self, args: InitializeArgs) -> Result<(), String> {
        let ix = Instruction {
            program_id: program_id(),
            accounts: beaver402_policy::accounts::Initialize {
                payer: self.payer.pubkey(),
                policy: self.policy,
                mint: self.mint,
                vault: self.vault,
                token_program: spl_token_interface::ID,
                associated_token_program: spl_associated_token_account_interface::program::ID,
                system_program: anchor_lang::solana_program::system_program::ID,
            }
            .to_account_metas(None),
            data: beaver402_policy::instruction::Initialize { args }.data(),
        };
        self.send(&[ix], &[])
    }

    pub fn fund_vault(&mut self, amount: u64) {
        let policy = self.policy;
        let vault = self.vault;
        let mut account = self.svm.get_account(&vault).unwrap();
        account.data = token_account(self.mint, policy, amount);
        self.svm.set_account(vault, account).unwrap();
    }

    pub fn balance(&self, token_account: &Pubkey) -> u64 {
        let account = self.svm.get_account(token_account).unwrap();
        TokenAccount::unpack(&account.data).unwrap().amount
    }

    pub fn recipient_token(&self) -> Pubkey {
        get_associated_token_address(&self.recipient.pubkey(), &self.mint)
    }

    pub fn recovery_token(&self) -> Pubkey {
        get_associated_token_address(&self.recovery.pubkey(), &self.mint)
    }

    pub fn state(&self) -> Policy {
        let account = self.svm.get_account(&self.policy).unwrap();
        *anchor_lang::__private::bytemuck::from_bytes::<Policy>(&account.data[8..])
    }

    pub fn now(&self) -> u64 {
        let clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp as u64
    }

    pub fn advance(&mut self, seconds: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp += seconds;
        self.svm.set_sysvar(&clock);
    }

    /// Send instructions, paid for by the payer and signed by `extra`.
    /// Returns the error name Anchor logged, or the transaction error.
    pub fn send(&mut self, instructions: &[Instruction], extra: &[&Keypair]) -> Result<(), String> {
        self.svm.expire_blockhash();
        let mut signers: Vec<&Keypair> = vec![&self.payer];
        signers.extend_from_slice(extra);
        let message = Message::new(instructions, Some(&self.payer.pubkey()));
        let tx = Transaction::new(&signers, message, self.svm.latest_blockhash());
        match self.svm.send_transaction(tx) {
            Ok(_) => Ok(()),
            Err(failed) => {
                if std::env::var("POLICY_LOGS").is_ok() {
                    eprintln!("{}", failed.meta.logs.join("\n"));
                }
                for line in &failed.meta.logs {
                    if let Some(at) = line.find("Error Code: ") {
                        let rest = &line[at + "Error Code: ".len()..];
                        return Err(rest.split('.').next().unwrap().to_string());
                    }
                }
                Err(format!("{:?}", failed.err))
            }
        }
    }

    /// Send instructions and return the program logs of a transaction that
    /// went through.
    pub fn send_logs(&mut self, instructions: &[Instruction], extra: &[&Keypair]) -> Result<Vec<String>, String> {
        self.svm.expire_blockhash();
        let mut signers: Vec<&Keypair> = vec![&self.payer];
        signers.extend_from_slice(extra);
        let message = Message::new(instructions, Some(&self.payer.pubkey()));
        let tx = Transaction::new(&signers, message, self.svm.latest_blockhash());
        self.svm
            .send_transaction(tx)
            .map(|meta| meta.logs)
            .map_err(|failed| format!("{:?}", failed.err))
    }

    /// Point the helpers at another policy account of the same owner. The
    /// account does not have to exist yet.
    pub fn use_policy(&mut self, policy_id: [u8; 32]) {
        self.policy_id = policy_id;
        self.policy = Pubkey::find_program_address(&[POLICY_SEED, &policy_id], &program_id()).0;
        self.vault = get_associated_token_address(&self.policy, &self.mint);
    }

    /// Create a second mint with the same decimals as the account's.
    pub fn other_mint(&mut self) -> Pubkey {
        let mint = Pubkey::new_unique();
        let mut data = vec![0u8; Mint::LEN];
        Mint {
            mint_authority: COption::Some(self.payer.pubkey()),
            supply: 1_000_000_000_000,
            decimals: 6,
            is_initialized: true,
            freeze_authority: COption::None,
        }
        .pack_into_slice(&mut data);
        self.svm
            .set_account(
                mint,
                Account {
                    lamports: self.svm.minimum_balance_for_rent_exemption(Mint::LEN),
                    data,
                    owner: spl_token_interface::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        mint
    }

    /// A token account of any mint, at its owner's associated address.
    pub fn token_account_of(&mut self, owner: Pubkey, mint: Pubkey, amount: u64) -> Pubkey {
        let address = get_associated_token_address(&owner, &mint);
        self.svm
            .set_account(
                address,
                Account {
                    lamports: self.svm.minimum_balance_for_rent_exemption(TokenAccount::LEN),
                    data: token_account(mint, owner, amount),
                    owner: spl_token_interface::ID,
                    executable: false,
                    rent_epoch: 0,
                },
            )
            .unwrap();
        address
    }

    // ── Payments ─────────────────────────────────────────────────

    pub fn next_nonce(&mut self) -> [u8; 32] {
        self.nonce_counter += 1;
        sha256(&[self.nonce_counter])
    }

    pub fn terms(&mut self, amount: u64) -> Terms {
        Terms {
            request_digest: sha256(b"GET https://api.merchant.test/data"),
            recipient: self.recipient.pubkey(),
            amount,
            nonce: self.next_nonce(),
            expiry: self.now() + 300,
            network: DEVNET.to_string(),
        }
    }

    pub fn challenge_hash(&self, terms: &Terms) -> [u8; 32] {
        let network_id = sha256(terms.network.as_bytes());
        domain_separated_hash(
            CHALLENGE_DOMAIN,
            &settlement_preimage(&Settlement {
                request_digest: &terms.request_digest,
                recipient: &terms.recipient,
                asset: &self.mint,
                amount: terms.amount,
                network_id: &network_id,
                nonce: &terms.nonce,
                expiry: terms.expiry,
            }),
        )
    }

    /// The precompile instruction carrying a merchant signature over a hash.
    pub fn merchant_signature(&self, signer: &Keypair, hash: &[u8; 32]) -> Instruction {
        let signature: [u8; 64] = signer.sign_message(hash).into();
        solana_ed25519_program::new_ed25519_instruction_with_signature(
            hash,
            &signature,
            &signer.pubkey().to_bytes(),
        )
    }

    pub fn pay_instruction(&self, agent: &Pubkey, signed: &Terms, paid: &Terms, recipient_token: Pubkey) -> Instruction {
        let _ = signed;
        Instruction {
            program_id: program_id(),
            accounts: beaver402_policy::accounts::Pay {
                agent: *agent,
                policy: self.policy,
                mint: self.mint,
                vault: self.vault,
                recipient: paid.recipient,
                recipient_token,
                token_program: spl_token_interface::ID,
                instructions: solana_instructions_sysvar::ID,
            }
            .to_account_metas(None),
            data: beaver402_policy::instruction::Pay {
                args: PayArgs {
                    merchant_pubkey: self.merchant.pubkey(),
                    request_digest: paid.request_digest,
                    amount: paid.amount,
                    nonce: paid.nonce,
                    expiry: paid.expiry,
                },
            }
            .data(),
        }
    }

    /// The payment the backend builds: the merchant's signature over the
    /// terms, then `pay` with the same terms, signed by the agent.
    pub fn pay(&mut self, terms: &Terms) -> Result<(), String> {
        let terms = terms.clone();
        self.pay_signed_for(&terms, &terms)
    }

    /// The merchant signs `signed`, the agent pays `paid`.
    pub fn pay_signed_for(&mut self, signed: &Terms, paid: &Terms) -> Result<(), String> {
        let hash = self.challenge_hash(signed);
        let signature = self.merchant_signature(&self.merchant, &hash);
        let recipient_token = get_associated_token_address(&paid.recipient, &self.mint);
        let pay = self.pay_instruction(&self.agent.pubkey(), signed, paid, recipient_token);
        let agent = self.agent.insecure_clone();
        self.send(&[signature, pay], &[&agent])
    }

    // ── Owner actions ────────────────────────────────────────────

    pub fn owner_instruction(
        &self,
        action: &str,
        pubkey: Option<Pubkey>,
        limits: Option<VelocityConfig>,
        proof: OwnerProof,
    ) -> Instruction {
        let owner_accounts = beaver402_policy::accounts::OwnerAction {
            policy: self.policy,
            instructions: solana_instructions_sysvar::ID,
        }
        .to_account_metas(None);
        let (accounts, data): (Vec<AccountMeta>, Vec<u8>) = match action {
            "freeze_payments" => (owner_accounts, beaver402_policy::instruction::FreezePayments { proof }.data()),
            "restore_payments" => (owner_accounts, beaver402_policy::instruction::RestorePayments { proof }.data()),
            "revoke_agent_signer" => (owner_accounts, beaver402_policy::instruction::RevokeAgentSigner { proof }.data()),
            "set_agent_signer" => (
                owner_accounts,
                beaver402_policy::instruction::SetAgentSigner { pubkey: pubkey.unwrap(), proof }.data(),
            ),
            "add_merchant" => (
                owner_accounts,
                beaver402_policy::instruction::AddMerchant { pubkey: pubkey.unwrap(), proof }.data(),
            ),
            "remove_merchant" => (
                owner_accounts,
                beaver402_policy::instruction::RemoveMerchant { pubkey: pubkey.unwrap(), proof }.data(),
            ),
            "reduce_limits" => (
                owner_accounts,
                beaver402_policy::instruction::ReduceLimits { config: limits.unwrap(), proof }.data(),
            ),
            "recover_funds" => (
                beaver402_policy::accounts::RecoverFunds {
                    policy: self.policy,
                    mint: self.mint,
                    vault: self.vault,
                    recovery: self.recovery.pubkey(),
                    recovery_token: self.recovery_token(),
                    token_program: spl_token_interface::ID,
                    instructions: solana_instructions_sysvar::ID,
                }
                .to_account_metas(None),
                beaver402_policy::instruction::RecoverFunds { proof }.data(),
            ),
            other => panic!("unknown action {other}"),
        };
        Instruction {
            program_id: program_id(),
            accounts,
            data,
        }
    }

    pub fn action_args(action: &str, pubkey: Option<Pubkey>, limits: Option<VelocityConfig>) -> Vec<u8> {
        match action {
            "set_agent_signer" | "add_merchant" | "remove_merchant" => pubkey.unwrap().to_bytes().to_vec(),
            "reduce_limits" => beaver402_policy::limits_bytes(&limits.unwrap()).to_vec(),
            _ => vec![],
        }
    }

    /// The precompile instruction and the proof for an owner action, signed
    /// by `passkey`, the way the browser and the backend produce them.
    pub fn owner_assertion(
        &self,
        passkey: &Passkey,
        action: &str,
        pubkey: Option<Pubkey>,
        limits: Option<VelocityConfig>,
        assertion: &Assertion,
    ) -> (Instruction, OwnerProof) {
        let valid_until = assertion.valid_until.unwrap_or(self.now() + 300);
        let expected = self.owner_challenge(action, pubkey, limits, valid_until);
        let carried = assertion.challenge.unwrap_or(expected);
        let client_data_json = client_data(&assertion.kind, &encode_challenge(&carried));
        self.signed_assertion(passkey, client_data_json, &assertion.rp_id, assertion.flags, valid_until)
    }

    /// The challenge the passkey has to sign for an action on this account
    /// right now.
    pub fn owner_challenge(
        &self,
        action: &str,
        pubkey: Option<Pubkey>,
        limits: Option<VelocityConfig>,
        valid_until: u64,
    ) -> [u8; 32] {
        let args = Self::action_args(action, pubkey, limits);
        challenge(&self.policy, action, &args, self.state().owner_nonce, valid_until)
    }

    /// Sign whatever clientDataJSON a test hands over, so it can break the
    /// JSON itself rather than the values in it.
    pub fn signed_assertion(
        &self,
        passkey: &Passkey,
        client_data_json: Vec<u8>,
        rp_id: &str,
        flags: u8,
        valid_until: u64,
    ) -> (Instruction, OwnerProof) {
        let mut message = sha256(rp_id.as_bytes()).to_vec();
        message.push(flags);
        message.extend_from_slice(&[0, 0, 0, 1]);
        message.extend_from_slice(&sha256(&client_data_json));

        let signature = passkey.sign(&message);
        let precompile =
            solana_secp256r1_program::new_secp256r1_instruction_with_signature(&message, &signature, &passkey.compressed);
        (
            precompile,
            OwnerProof {
                client_data_json,
                valid_until,
            },
        )
    }

    pub fn owner_action(
        &mut self,
        action: &str,
        pubkey: Option<Pubkey>,
        limits: Option<VelocityConfig>,
        assertion: Assertion,
    ) -> Result<(), String> {
        let (precompile, proof) = self.owner_assertion(&self.owner, action, pubkey, limits, &assertion);
        let ix = self.owner_instruction(action, pubkey, limits, proof);
        self.send(&[precompile, ix], &[])
    }

    pub fn owner(&mut self, action: &str) -> Result<(), String> {
        self.owner_action(action, None, None, Assertion::default())
    }
}

/// clientDataJSON the way a browser writes it for an assertion.
pub fn client_data(kind: &str, challenge: &str) -> Vec<u8> {
    format!(
        r#"{{"type":"{}","challenge":"{}","origin":"https://{}","crossOrigin":false}}"#,
        kind, challenge, RP_ID
    )
    .into_bytes()
}

pub fn encode_challenge(challenge: &[u8; 32]) -> String {
    String::from_utf8(base64url_encode(challenge).to_vec()).unwrap()
}

/// The events this program emitted, read from the logs of a transaction.
pub fn events<E: anchor_lang::Event + anchor_lang::AnchorDeserialize>(logs: &[String]) -> Vec<E> {
    logs.iter()
        .filter_map(|line| line.strip_prefix("Program data: "))
        .map(base64_decode)
        .filter(|data| data.starts_with(E::DISCRIMINATOR))
        .map(|data| E::try_from_slice(&data[E::DISCRIMINATOR.len()..]).unwrap())
        .collect()
}

fn base64_decode(text: &str) -> Vec<u8> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let mut buffer = 0u32;
    let mut bits = 0;
    for byte in text.bytes().filter(|b| *b != b'=') {
        let value = ALPHABET.iter().position(|c| *c == byte).unwrap() as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    out
}
