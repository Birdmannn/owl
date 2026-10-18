use blake2b_ref::Blake2bBuilder;
use ckb_testtool::{builtin::ALWAYS_SUCCESS, ckb_types::{bytes::Bytes, core::{TransactionBuilder, TransactionView}, packed::*, prelude::*}, context::Context};
use k256::ecdsa::{signature::hazmat::PrehashSigner, Signature, SigningKey};
const CAP: u64 = 500 * 100_000_000;
fn key(n: u8) -> SigningKey { SigningKey::from_slice(&[n; 32]).unwrap() }
fn state(generic: bool, after: bool) -> Bytes { if generic { (5u64 + u64::from(after)).to_le_bytes().to_vec().into() } else { [(if after { 1000u64 } else { 2000 }).to_le_bytes(), u64::from(after).to_le_bytes()].concat().into() } }
struct Fixture { context: Context, tx: TransactionView, generic: bool }
fn fixture(generic: bool) -> Fixture {
 let mut context=Context::default();
 let name=if generic { "pilot-sponsored-delegation-lock" } else { "pilot-sponsored-session-lock" };
 let code=std::fs::read(format!("{}/../build/{name}",env!("CARGO_MANIFEST_DIR"))).unwrap();
 let dep=context.deploy_cell(code.into()); let ordinary=context.deploy_cell(ALWAYS_SUCCESS.clone());
 let owner=context.build_script(&ordinary,Bytes::from(vec![1])).unwrap();
 let pool=context.build_script(&ordinary,Bytes::from(vec![2])).unwrap();
 let mut args=[owner.calc_script_hash().as_slice(),key(1).verifying_key().to_encoded_point(true).as_bytes()].concat();
 if generic { args.extend([3;32]); args.extend([0;32]); }
 args.extend(1000u64.to_le_bytes()); args.extend(CAP.to_le_bytes());
 if generic { args.push(1); args.extend([4;32]); args.push(0); args.extend(0u32.to_le_bytes()); args.extend(1u64.to_le_bytes()); }
 args.extend(pool.calc_script_hash().as_slice());
 let lock=context.build_script(&dep,args.into()).unwrap();
 let app=context.create_cell(CellOutput::new_builder().capacity(CAP).lock(lock.clone()).build(),state(generic,false));
 let funding=context.create_cell(CellOutput::new_builder().capacity(CAP).lock(pool.clone()).build(),Bytes::new());
 let tx=TransactionBuilder::default()
 .input(CellInput::new_builder().previous_output(app).build()).input(CellInput::new_builder().previous_output(funding).build())
 .output(CellOutput::new_builder().capacity(CAP).lock(lock).build()).output_data(state(generic,true))
 .output(CellOutput::new_builder().capacity(CAP-500).lock(pool).build()).output_data(Bytes::new())
 .witness(WitnessArgs::default().as_bytes()).witness(WitnessArgs::new_builder().lock(Some(Bytes::from(vec![0;65])).pack()).build().as_bytes()).build();
 let tx=context.complete_tx(tx); Fixture{context,tx,generic}
}
fn sign(f:&Fixture,tx:TransactionView,who:u8)->TransactionView {
 let mut lock=vec![1]; if f.generic {lock.extend([4;32]);}
 let unsigned=WitnessArgs::new_builder().lock(Some(Bytes::from(lock.clone())).pack()).build();
 let mut witnesses:Vec<Bytes>=tx.witnesses().into_iter().map(|w|w.raw_data()).collect(); witnesses[0]=unsigned.as_bytes();
 let digest=if f.generic {
  let mut hasher=Blake2bBuilder::new(32).personal(b"ckb-default-hash").build(); hasher.update(b"owl-pilot-delegation-sponsored-v1"); hasher.update(tx.hash().as_slice());
  for (i,witness) in witnesses.iter().enumerate() {
   let normalized; let bytes=if i==1 { normalized=WitnessArgs::from_slice(witness).unwrap().as_builder().lock(Some(Bytes::new()).pack()).build(); normalized.as_slice() } else { witness.as_ref() };
   hasher.update(&(bytes.len() as u64).to_le_bytes()); hasher.update(bytes);
  } let mut digest=[0;32]; hasher.finalize(&mut digest); digest
 } else {tx.hash().as_slice().try_into().unwrap()};
 let sig:Signature=key(who).sign_prehash(&digest).unwrap(); lock.extend(sig.to_bytes());
 witnesses[0]=unsigned.as_builder().lock(Some(Bytes::from(lock)).pack()).build().as_bytes();
 tx.as_advanced_builder().set_witnesses(witnesses.into_iter().map(|w|w.pack()).collect()).build()
}
fn verify(f:&Fixture,tx:&TransactionView)->Result<u64,String>{f.context.verify_tx(tx,100_000_000).map_err(|e|format!("{e:?}"))}
#[test] fn pool_pays_entire_fee_and_app_capacity_is_preserved(){for generic in [false,true]{let f=fixture(generic);verify(&f,&sign(&f,f.tx.clone(),1)).unwrap();}}
#[test] fn user_capacity_cannot_pay_any_fee(){for generic in [false,true]{let f=fixture(generic);let mut outputs:Vec<CellOutput>=f.tx.outputs().into_iter().collect();outputs[0]=outputs[0].clone().as_builder().capacity(CAP-1).build();let tx=f.tx.as_advanced_builder().set_outputs(outputs).build();assert!(verify(&f,&sign(&f,tx,1)).is_err());}}
#[test] fn pool_change_cannot_be_redirected(){for generic in [false,true]{let f=fixture(generic);let mut outputs:Vec<CellOutput>=f.tx.outputs().into_iter().collect();let lock=outputs[1].lock().as_builder().args(Bytes::from(vec![99]).pack()).build();outputs[1]=outputs[1].clone().as_builder().lock(lock).build();let tx=f.tx.as_advanced_builder().set_outputs(outputs).build();assert!(verify(&f,&sign(&f,tx,1)).is_err());}}
#[test] fn pool_fee_cannot_exceed_approved_cap(){for generic in [false,true]{let f=fixture(generic);let mut outputs:Vec<CellOutput>=f.tx.outputs().into_iter().collect();outputs[1]=outputs[1].clone().as_builder().capacity(CAP-1001).build();let tx=f.tx.as_advanced_builder().set_outputs(outputs).build();assert!(verify(&f,&sign(&f,tx,1)).is_err());}}
#[test] fn wrong_session_key_and_unapproved_state_are_rejected(){for generic in [false,true]{let f=fixture(generic);assert!(verify(&f,&sign(&f,f.tx.clone(),2)).is_err());let tx=f.tx.as_advanced_builder().set_outputs_data(vec![state(generic,false).pack(),Bytes::new().pack()]).build();assert!(verify(&f,&sign(&f,tx,1)).is_err());}}
#[test] fn session_cannot_add_payment_or_change_pool_data(){for generic in [false,true]{let f=fixture(generic);let tx=f.tx.as_advanced_builder().output(f.tx.outputs().get(1).unwrap()).output_data(Bytes::new()).build();assert!(verify(&f,&sign(&f,tx,1)).is_err());let tx=f.tx.as_advanced_builder().set_outputs_data(vec![state(generic,true).pack(),Bytes::from(vec![1]).pack()]).build();assert!(verify(&f,&sign(&f,tx,1)).is_err());}}
#[test] fn pool_can_cosign_after_delegation_but_cannot_change_type_witness(){let f=fixture(true);let signed=sign(&f,f.tx.clone(),1);let pool=WitnessArgs::from_slice(signed.witnesses().get(1).unwrap().raw_data().as_ref()).unwrap().as_builder().lock(Some(Bytes::from(vec![7;65])).pack()).build();let mut witnesses:Vec<ckb_testtool::ckb_types::packed::Bytes>=signed.witnesses().into_iter().collect();witnesses[1]=pool.as_bytes().pack();let signed=signed.as_advanced_builder().set_witnesses(witnesses.clone()).build();verify(&f,&signed).unwrap();witnesses[1]=pool.as_builder().input_type(Some(Bytes::from(vec![1])).pack()).build().as_bytes().pack();let changed=signed.as_advanced_builder().set_witnesses(witnesses).build();assert!(verify(&f,&changed).is_err());}
