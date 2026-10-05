//! Reading the transaction the program runs in.
//!
//! Signatures that are not the transaction's own are checked by the runtime's
//! precompiles, which run as separate instructions. The program only learns
//! that a precompile succeeded by finding its instruction in the same
//! transaction and reading what it verified. Getting this wrong is the
//! classic way a Solana program accepts a forged signature, so every part of
//! the layout is pinned down here:
//!
//! - the transaction holds compute budget instructions, exactly one
//!   instruction for the expected precompile, and exactly one instruction for
//!   this program, which is the one running; nothing else
//! - the precompile instruction verifies exactly one signature
//! - its key, signature and message all live inside that same instruction,
//!   so the bytes read here are the bytes that were verified

use anchor_lang::prelude::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::error::PolicyError;

/// The precompiles mark "this instruction" with the largest index.
const THIS_INSTRUCTION: u16 = u16::MAX;
/// num_signatures, then one padding byte.
const OFFSETS_START: usize = 2;
const OFFSETS_LEN: usize = 14;

/// What a precompile instruction verified.
pub struct Verified {
    pub public_key: Vec<u8>,
    pub message: Vec<u8>,
}

/// Check the transaction's layout and return what the single precompile
/// instruction verified.
pub fn verified_by_precompile(
    instructions: &AccountInfo,
    precompile: &Pubkey,
    public_key_len: usize,
    signature_len: usize,
) -> Result<Verified> {
    let current = load_current_index_checked(instructions)
        .map_err(|_| error!(PolicyError::UnexpectedInstruction))? as usize;

    let mut precompile_data: Option<Vec<u8>> = None;
    let mut own_instructions = 0usize;
    let mut index = 0usize;
    while let Ok(instruction) = load_instruction_at_checked(index, instructions) {
        let program = instruction.program_id;
        if program == solana_sdk_ids::compute_budget::ID {
            // Fee and compute settings move no money and authorize nothing.
        } else if program == *precompile {
            if precompile_data.is_some() {
                return err!(PolicyError::UnexpectedInstruction);
            }
            precompile_data = Some(instruction.data);
        } else if program == crate::ID {
            // Only the instruction running now. A second call into this
            // program could ride on the same signature.
            if index != current {
                return err!(PolicyError::UnexpectedInstruction);
            }
            own_instructions += 1;
        } else {
            return err!(PolicyError::UnexpectedInstruction);
        }
        index += 1;
    }
    if own_instructions != 1 {
        return err!(PolicyError::UnexpectedInstruction);
    }
    let data = precompile_data.ok_or(error!(PolicyError::InvalidSignatureFormat))?;

    parse_single_signature(&data, public_key_len, signature_len)
}

fn read_u16(data: &[u8], at: usize) -> Result<u16> {
    let bytes = data
        .get(at..at + 2)
        .ok_or(error!(PolicyError::InvalidSignatureFormat))?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

fn slice(data: &[u8], offset: u16, len: usize) -> Result<Vec<u8>> {
    let start = offset as usize;
    data.get(start..start + len)
        .map(|s| s.to_vec())
        .ok_or(error!(PolicyError::InvalidSignatureFormat))
}

/// The ed25519 and secp256r1 precompiles share one layout: a signature count,
/// a padding byte, fourteen bytes of offsets per signature, then the data.
pub fn parse_single_signature(
    data: &[u8],
    public_key_len: usize,
    signature_len: usize,
) -> Result<Verified> {
    if data.len() < OFFSETS_START + OFFSETS_LEN || data[0] != 1 {
        return err!(PolicyError::InvalidSignatureFormat);
    }
    let at = OFFSETS_START;
    let signature_offset = read_u16(data, at)?;
    let signature_index = read_u16(data, at + 2)?;
    let public_key_offset = read_u16(data, at + 4)?;
    let public_key_index = read_u16(data, at + 6)?;
    let message_offset = read_u16(data, at + 8)?;
    let message_size = read_u16(data, at + 10)?;
    let message_index = read_u16(data, at + 12)?;

    // Everything has to come from the precompile instruction itself.
    // Otherwise the bytes read below are not the bytes it verified.
    if signature_index != THIS_INSTRUCTION
        || public_key_index != THIS_INSTRUCTION
        || message_index != THIS_INSTRUCTION
    {
        return err!(PolicyError::InvalidSignatureFormat);
    }

    // The signature itself only has to be present; the precompile checked it.
    slice(data, signature_offset, signature_len)?;
    Ok(Verified {
        public_key: slice(data, public_key_offset, public_key_len)?,
        message: slice(data, message_offset, message_size as usize)?,
    })
}
