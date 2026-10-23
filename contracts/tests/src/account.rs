use blake2b_ref::Blake2bBuilder;
use ckb_testtool::{builtin::ALWAYS_SUCCESS, ckb_types::{bytes::Bytes, core::{TransactionBuilder, TransactionView}, packed::*, prelude::*}, context::Context};
use k256::ecdsa::{signature::hazmat::PrehashSigner, Signature, SigningKey};
const CAP: u64 = 500 * 100_000_000;
fn key(n:u8)->SigningKey{SigningKey::from_slice(&[n;32]).unwrap()}
struct Fixture{context:Context,tx:TransactionView,account:Script,owner:Script,pool:Script}
fn fixture()->Fixture{
 let mut context=Context::default();
 let code=std::fs::read(format!("{}/../build/pilot-account-lock",env!("CARGO_MANIFEST_DIR"))).unwrap();
 let dep=context.deploy_cell(code.into());let ordinary=context.deploy_cell(ALWAYS_SUCCESS.clone());
 let owner=context.build_script(&ordinary,Bytes::from(vec![1])).unwrap();let pool=context.build_script(&ordinary,Bytes::from(vec![2])).unwrap();
 let args=[owner.calc_script_hash().as_slice(),key(1).verifying_key().to_encoded_point(true).as_bytes(),pool.calc_script_hash().as_slice(),&1000u64.to_le_bytes()].concat();
 let account=context.build_script(&dep,args.into()).unwrap();
 let input=context.create_cell(CellOutput::new_builder().capacity(CAP).lock(account.clone()).build(),Bytes::new());
 let funding=context.create_cell(CellOutput::new_builder().capacity(CAP).lock(pool.clone()).build(),Bytes::new());
 // This is an arbitrary payment to a different owner, not a counter successor.
 let tx=TransactionBuilder::default().input(CellInput::new_builder().previous_output(input).build())
 .input(CellInput::new_builder().previous_output(funding).build())
 .output(CellOutput::new_builder().capacity(CAP).lock(owner.clone()).build()).output_data(Bytes::from(vec![9,8,7]))
 .output(CellOutput::new_builder().capacity(CAP-500).lock(pool.clone()).build()).output_data(Bytes::new())
 .witness(WitnessArgs::default().as_bytes()).witness(WitnessArgs::new_builder().lock(Some(Bytes::from(vec![0;65])).pack()).build().as_bytes()).build();
 let tx=context.complete_tx(tx);Fixture{context,tx,account,owner,pool}
}
fn sign(tx:TransactionView,who:u8,index:usize)->TransactionView{
 let mut ws:Vec<Bytes>=tx.witnesses().into_iter().map(|w|w.raw_data()).collect();
 ws[index]=WitnessArgs::from_slice(&ws[index]).unwrap().as_builder().lock(Some(Bytes::from(vec![1])).pack()).build().as_bytes();
 let mut h=Blake2bBuilder::new(32).personal(b"ckb-default-hash").build();h.update(b"owl-pilot-account-v1");h.update(tx.hash().as_slice());
 let pool=tx.inputs().len()-1;
 for(i,w)in ws.iter().enumerate(){let normalized;let bytes=if i==pool{normalized=WitnessArgs::from_slice(w).unwrap().as_builder().lock(Some(Bytes::new()).pack()).build();normalized.as_slice()}else{w.as_ref()};h.update(&(bytes.len()as u64).to_le_bytes());h.update(bytes);}
 let mut digest=[0;32];h.finalize(&mut digest);let signature:Signature=key(who).sign_prehash(&digest).unwrap();
 ws[index]=WitnessArgs::from_slice(&ws[index]).unwrap().as_builder().lock(Some(Bytes::from([vec![1],signature.to_bytes().to_vec()].concat())).pack()).build().as_bytes();
 tx.as_advanced_builder().set_witnesses(ws.into_iter().map(|w|w.pack()).collect()).build()
}
fn verify(f:&Fixture,tx:&TransactionView)->Result<u64,String>{f.context.verify_tx(tx,100_000_000).map_err(|e|format!("{e:?}"))}
#[test]fn general_payment_succeeds_without_counter_transition(){let f=fixture();let cycles=verify(&f,&sign(f.tx.clone(),1,0)).unwrap();println!("account cycles: {cycles}");}
#[test]fn multiple_account_inputs_and_outputs_are_supported(){let mut f=fixture();let input=f.context.create_cell(CellOutput::new_builder().capacity(CAP).lock(f.account.clone()).build(),Bytes::new());let tx=f.tx.as_advanced_builder().set_inputs(vec![f.tx.inputs().get(0).unwrap(),CellInput::new_builder().previous_output(input).build(),f.tx.inputs().get(1).unwrap()]).output(CellOutput::new_builder().capacity(CAP).lock(f.account.clone()).build()).output_data(Bytes::new()).set_witnesses(vec![WitnessArgs::default().as_bytes().pack();3]).build();let mut outs:Vec<CellOutput>=tx.outputs().into_iter().collect();outs.swap(1,2);let mut data:Vec<ckb_testtool::ckb_types::packed::Bytes>=tx.outputs_data().into_iter().collect();data.swap(1,2);let tx=tx.as_advanced_builder().set_outputs(outs).set_outputs_data(data).build();verify(&f,&sign(tx,1,0)).unwrap();}
#[test]fn account_can_be_at_nonzero_input_index(){let mut f=fixture();let other=f.context.create_cell(CellOutput::new_builder().capacity(CAP).lock(f.owner.clone()).build(),Bytes::new());let tx=f.tx.as_advanced_builder().set_inputs(vec![CellInput::new_builder().previous_output(other).build(),f.tx.inputs().get(0).unwrap(),f.tx.inputs().get(1).unwrap()]).set_outputs(vec![f.tx.outputs().get(0).unwrap().as_builder().capacity(2*CAP).build(),f.tx.outputs().get(1).unwrap()]).set_witnesses(vec![WitnessArgs::default().as_bytes().pack();3]).build();verify(&f,&sign(tx,1,1)).unwrap();}
#[test]fn wrong_key_and_tampered_payment_rejected(){let f=fixture();assert!(verify(&f,&sign(f.tx.clone(),2,0)).is_err());let signed=sign(f.tx.clone(),1,0);let tx=signed.as_advanced_builder().set_outputs_data(vec![Bytes::from(vec![7,8,9]).pack(),Bytes::new().pack()]).build();assert!(verify(&f,&tx).is_err());}
#[test]fn user_cannot_pay_any_network_fee(){let f=fixture();let tx=f.tx.as_advanced_builder().set_outputs(vec![f.tx.outputs().get(0).unwrap().as_builder().capacity(CAP-1).build(),f.tx.outputs().get(1).unwrap()]).build();assert!(verify(&f,&sign(tx,1,0)).is_err());}
#[test]fn sponsorship_cap_and_pool_identity_enforced(){let f=fixture();let tx=f.tx.as_advanced_builder().set_outputs(vec![f.tx.outputs().get(0).unwrap(),f.tx.outputs().get(1).unwrap().as_builder().capacity(CAP-1001).build()]).build();assert!(verify(&f,&sign(tx,1,0)).is_err());let tx=f.tx.as_advanced_builder().set_outputs(vec![f.tx.outputs().get(0).unwrap(),f.tx.outputs().get(1).unwrap().as_builder().lock(f.owner.clone()).build()]).build();assert!(verify(&f,&sign(tx,1,0)).is_err());}
#[test]fn pool_can_cosign_but_cannot_change_type_witnesses(){let f=fixture();let signed=sign(f.tx.clone(),1,0);let pool=WitnessArgs::new_builder().lock(Some(Bytes::from(vec![5;65])).pack()).build();let tx=signed.as_advanced_builder().set_witnesses(vec![signed.witnesses().get(0).unwrap(),pool.as_bytes().pack()]).build();verify(&f,&tx).unwrap();let changed=pool.as_builder().input_type(Some(Bytes::from(vec![1])).pack()).build();let tx=tx.as_advanced_builder().set_witnesses(vec![signed.witnesses().get(0).unwrap(),changed.as_bytes().pack()]).build();assert!(verify(&f,&tx).is_err());}
#[test]fn extra_witnesses_are_committed(){let f=fixture();let tx=f.tx.as_advanced_builder().witness(Bytes::from(vec![1,2,3])).build();let signed=sign(tx,1,0);verify(&f,&signed).unwrap();let changed=signed.as_advanced_builder().witness(Bytes::from(vec![4])).build();assert!(verify(&f,&changed).is_err());}
#[test]fn owner_recovers_without_pilot_key_or_sponsor(){let mut f=fixture();let proof=f.context.create_cell(CellOutput::new_builder().capacity(CAP).lock(f.owner.clone()).build(),Bytes::new());let tx=TransactionBuilder::default().input(f.tx.inputs().get(0).unwrap()).input(CellInput::new_builder().previous_output(proof).build()).output(CellOutput::new_builder().capacity(2*CAP-500).lock(f.owner.clone()).build()).output_data(Bytes::new()).witness(WitnessArgs::new_builder().lock(Some(Bytes::from(vec![0])).pack()).build().as_bytes()).build();let tx=f.context.complete_tx(tx);verify(&f,&tx).unwrap();}
#[test]fn wrong_owner_and_lookalike_args_cannot_recover(){let mut f=fixture();let fake=f.owner.clone().as_builder().args(Bytes::from(vec![99]).pack()).build();let proof=f.context.create_cell(CellOutput::new_builder().capacity(CAP).lock(fake).build(),Bytes::new());let tx=f.tx.as_advanced_builder().set_inputs(vec![f.tx.inputs().get(0).unwrap(),CellInput::new_builder().previous_output(proof).build()]).set_witnesses(vec![WitnessArgs::new_builder().lock(Some(Bytes::from(vec![0])).pack()).build().as_bytes().pack(),WitnessArgs::default().as_bytes().pack()]).build();let tx=f.context.complete_tx(tx);assert!(verify(&f,&tx).is_err());}
#[test]fn duplicate_pool_inputs_rejected(){let mut f=fixture();let cell=f.context.create_cell(CellOutput::new_builder().capacity(CAP).lock(f.pool.clone()).build(),Bytes::new());let tx=f.tx.as_advanced_builder().set_inputs(vec![f.tx.inputs().get(0).unwrap(),CellInput::new_builder().previous_output(cell).build(),f.tx.inputs().get(1).unwrap()]).set_outputs(vec![f.tx.outputs().get(0).unwrap().as_builder().capacity(2*CAP).build(),f.tx.outputs().get(1).unwrap()]).set_witnesses(vec![WitnessArgs::default().as_bytes().pack();3]).build();assert!(verify(&f,&sign(tx,1,0)).is_err());}
