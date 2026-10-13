#[cfg(test)]
mod tests {
    use ckb_testtool::{
        builtin::ALWAYS_SUCCESS,
        ckb_types::{
            bytes::Bytes,
            core::{TransactionBuilder, TransactionView},
            packed::*,
            prelude::*,
        },
        context::Context,
    };
    use k256::ecdsa::{signature::hazmat::PrehashSigner, Signature, SigningKey};

    const CAPACITY: u64 = 200 * 100_000_000;
    const FLOOR: u64 = 150 * 100_000_000;
    fn data(budget: u64, position: u64) -> Bytes {
        [budget.to_le_bytes(), position.to_le_bytes()]
            .concat()
            .into()
    }
    fn key(n: u8) -> SigningKey {
        SigningKey::from_slice(&[n; 32]).unwrap()
    }
    fn sign(tx: TransactionView, key: &SigningKey) -> TransactionView {
        let signature: Signature = key.sign_prehash(tx.hash().as_slice()).unwrap();
        let witness = WitnessArgs::new_builder()
            .lock(
                Some(Bytes::from(
                    [vec![1], signature.to_bytes().to_vec()].concat(),
                ))
                .pack(),
            )
            .build();
        tx.as_advanced_builder()
            .set_witnesses(vec![witness.as_bytes().pack()])
            .build()
    }
    struct Fixture {
        context: Context,
        tx: TransactionView,
        lock: Script,
        owner: Script,
    }
    fn fixture() -> Fixture {
        let mut context = Context::default();
        let code = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../build/pilot-session-lock"
        ))
        .expect("build contract first");
        let deployed = context.deploy_cell(code.into());
        let owner_code = context.deploy_cell(ALWAYS_SUCCESS.clone());
        let owner = context.build_script(&owner_code, Bytes::new()).unwrap();
        let args: Bytes = [
            owner.calc_script_hash().as_slice(),
            key(1).verifying_key().to_encoded_point(true).as_bytes(),
            &1000u64.to_le_bytes(),
            &FLOOR.to_le_bytes(),
        ]
        .concat()
        .into();
        let lock = context.build_script(&deployed, args).unwrap();
        let input = context.create_cell(
            CellOutput::new_builder()
                .capacity(CAPACITY)
                .lock(lock.clone())
                .build(),
            data(2000, 0),
        );
        let tx = TransactionBuilder::default()
            .input(CellInput::new_builder().previous_output(input).build())
            .output(
                CellOutput::new_builder()
                    .capacity(CAPACITY - 1000)
                    .lock(lock.clone())
                    .build(),
            )
            .output_data(data(1000, 1))
            .build();
        let tx = context.complete_tx(tx);
        Fixture {
            context,
            tx,
            lock,
            owner,
        }
    }
    fn verify(fixture: &Fixture, tx: &TransactionView) -> Result<u64, String> {
        fixture
            .context
            .verify_tx(tx, 100_000_000)
            .map_err(|error| format!("{error:?}"))
    }
    fn rejects(f: &Fixture, tx: TransactionView, code: i8) {
        let error = verify(f, &tx).unwrap_err();
        assert!(
            error.contains(&format!("error code {code}"))
                || error.contains(&format!("ValidationFailure({code})")),
            "{error}"
        );
    }
    #[test]
    fn session_signature_advances_position_and_debits_fee() {
        let f = fixture();
        let cycles = verify(&f, &sign(f.tx.clone(), &key(1))).unwrap();
        println!("session lock cycles: {cycles}");
    }
    #[test]
    fn wrong_session_key_is_rejected() {
        let f = fixture();
        rejects(&f, sign(f.tx.clone(), &key(2)), 6);
    }
    #[test]
    fn unauthorized_move_is_rejected_even_with_valid_signature() {
        let f = fixture();
        let tx =
            f.tx.as_advanced_builder()
                .set_outputs_data(vec![data(1000, 2).pack()])
                .build();
        rejects(&f, sign(tx, &key(1)), 8);
    }
    #[test]
    fn fee_above_per_move_limit_is_rejected() {
        let f = fixture();
        let tx =
            f.tx.as_advanced_builder()
                .set_outputs(vec![CellOutput::new_builder()
                    .capacity(CAPACITY - 2001)
                    .lock(f.lock.clone())
                    .build()])
                .set_outputs_data(vec![data(0, 1).pack()])
                .build();
        rejects(&f, sign(tx, &key(1)), 9);
    }
    #[test]
    fn cumulative_budget_cannot_be_reset() {
        let f = fixture();
        let tx =
            f.tx.as_advanced_builder()
                .set_outputs_data(vec![data(2000, 1).pack()])
                .build();
        rejects(&f, sign(tx, &key(1)), 9);
    }
    #[test]
    fn spending_after_budget_exhaustion_is_rejected() {
        let mut f = fixture();
        let input = f.context.create_cell(
            CellOutput::new_builder()
                .capacity(CAPACITY)
                .lock(f.lock.clone())
                .build(),
            data(0, 0),
        );
        let tx =
            f.tx.as_advanced_builder()
                .set_inputs(vec![CellInput::new_builder()
                    .previous_output(input)
                    .build()])
                .set_outputs_data(vec![data(0, 1).pack()])
                .build();
        rejects(&f, sign(tx, &key(1)), 9);
    }
    #[test]
    fn changing_successor_owner_is_rejected() {
        let f = fixture();
        let tx =
            f.tx.as_advanced_builder()
                .set_outputs(vec![CellOutput::new_builder()
                    .capacity(CAPACITY - 1000)
                    .lock(f.owner.clone())
                    .build()])
                .build();
        rejects(&f, sign(tx, &key(1)), 7);
    }
    #[test]
    fn owner_mode_without_owner_input_is_rejected() {
        let f = fixture();
        let witness = WitnessArgs::new_builder()
            .lock(Some(Bytes::from(vec![0])).pack())
            .build();
        rejects(
            &f,
            f.tx.as_advanced_builder()
                .witness(witness.as_bytes())
                .build(),
            6,
        );
    }
    #[test]
    fn owner_input_can_reclaim_session_cell() {
        let mut f = fixture();
        let owner_input = f.context.create_cell(
            CellOutput::new_builder()
                .capacity(CAPACITY)
                .lock(f.owner.clone())
                .build(),
            Bytes::new(),
        );
        let witness = WitnessArgs::new_builder()
            .lock(Some(Bytes::from(vec![0])).pack())
            .build();
        let tx =
            f.tx.as_advanced_builder()
                .input(
                    CellInput::new_builder()
                        .previous_output(owner_input)
                        .build(),
                )
                .set_outputs(vec![CellOutput::new_builder()
                    .capacity(2 * CAPACITY - 1000)
                    .lock(f.owner.clone())
                    .build()])
                .set_outputs_data(vec![Bytes::new().pack()])
                .witness(witness.as_bytes())
                .build();
        let tx = f.context.complete_tx(tx);
        verify(&f, &tx).unwrap();
    }
    #[test]
    fn session_cannot_add_an_extra_payment() {
        let f = fixture();
        let tx =
            f.tx.as_advanced_builder()
                .output(
                    CellOutput::new_builder()
                        .capacity(61 * 100_000_000)
                        .lock(f.owner.clone())
                        .build(),
                )
                .output_data(Bytes::new())
                .build();
        rejects(&f, sign(tx, &key(1)), 7);
    }
}
