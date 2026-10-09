fn main() {
    // The agent commands must be declared here so the ACL knows them; the
    // capability then grants them (allow-<command>) to the hosted origin.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "store_agent_key",
            "has_agent_key",
            "forget_agent_key",
            "install_agent",
        ])),
    )
    .expect("failed to run tauri-build");
}
