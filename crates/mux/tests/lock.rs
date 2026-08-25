#[test]
fn second_process_connects_does_not_spawn() {
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join("mux.lock");
    let a = gmuxd::lock::acquire(&lock).unwrap();
    let b = gmuxd::lock::acquire(&lock);
    assert!(matches!(b, Err(gmuxd::lock::LockError::Held { .. })));
    drop(a);
}
