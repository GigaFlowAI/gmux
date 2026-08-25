use gmuxd::peer::{CallerClass, ClassifyError, PidTree, classify};

fn pane(id: &str, pids: &[u32]) -> PidTree {
    PidTree {
        pane_id: id.to_string(),
        pids: pids.to_vec(),
    }
}

#[test]
fn classify_table() {
    let tree = pane("p_parent", &[100, 101, 102]);

    assert_eq!(
        classify(9, &[tree.clone()], true, None, Some(9)).unwrap(),
        CallerClass::Intel
    );

    assert!(matches!(
        classify(9, &[tree.clone()], false, None, Some(9)),
        Err(ClassifyError::PermissionDenied { .. })
    ));

    assert!(matches!(
        classify(50, &[tree.clone()], true, None, Some(9)),
        Err(ClassifyError::PermissionDenied { .. })
    ));

    assert_eq!(
        classify(101, &[tree.clone()], false, Some("p_parent"), None).unwrap(),
        CallerClass::Pane
    );

    let missing = classify(101, &[tree.clone()], false, None, None);
    assert!(
        matches!(missing, Err(ClassifyError::PermissionDenied { .. })),
        "missing GMUX_PANE_ID must not promote to cli: {missing:?}"
    );

    let mismatch = classify(101, &[tree.clone()], false, Some("p_other"), None);
    assert!(
        matches!(mismatch, Err(ClassifyError::PermissionDenied { .. })),
        "mismatched GMUX_PANE_ID must not promote to cli: {mismatch:?}"
    );

    assert_eq!(
        classify(50, &[tree], false, None, None).unwrap(),
        CallerClass::Cli
    );
}

#[test]
fn tui_is_not_classified_by_pid() {
    // TUI identifies via `client.attach` hello, not pid. A host process that
    // is not intel and not in a pane tree is `cli`.
    assert_eq!(
        classify(7, &[], false, None, None).unwrap(),
        CallerClass::Cli
    );
    assert_ne!(
        classify(7, &[], false, None, None).unwrap(),
        CallerClass::Tui
    );
}
