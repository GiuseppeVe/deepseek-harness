use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// App-private directories used by one DSH Desktop instance.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPaths {
    pub data_dir: PathBuf,
    pub dsh_home: PathBuf,
    pub logs_dir: PathBuf,
    pub runtime_dir: PathBuf,
    pub source_dsh_cli: PathBuf,
}

/// Resolves directories without reading caller home or environment state.
pub fn resolve_desktop_paths<F>(data_directory: F, source_dsh_cli: &Path) -> DesktopPaths
where
    F: FnOnce() -> PathBuf,
{
    let data_dir = data_directory().join("DSH Desktop");
    DesktopPaths {
        dsh_home: data_dir.join("dsh-home"),
        logs_dir: data_dir.join("logs"),
        runtime_dir: data_dir.join("runtime"),
        source_dsh_cli: source_dsh_cli.to_path_buf(),
        data_dir,
    }
}

/// JSON input accepted only by focused test adapter.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPathsTestRequest {
    pub app_data: PathBuf,
    pub user_home: PathBuf,
    pub source_dsh_cli: PathBuf,
}

/// Runs resolver through narrow JSON test adapter.
pub fn resolve_desktop_paths_for_test(request: DesktopPathsTestRequest) -> DesktopPaths {
    let DesktopPathsTestRequest {
        app_data,
        user_home: _,
        source_dsh_cli,
    } = request;
    resolve_desktop_paths(|| app_data, &source_dsh_cli)
}

/// Boots DSH Desktop Tauri host.
pub fn run() -> tauri::Result<()> {
    tauri::Builder::default()
        .run(tauri::generate_context!())
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::resolve_desktop_paths;

    #[test]
    fn resolves_every_directory_under_private_app_data() {
        let app_data = PathBuf::from("C:/fixture/AppData/Local");
        let user_home = Path::new("C:/fixture/User");
        let source_dsh_cli = Path::new("../../dsh.ts");
        let paths = resolve_desktop_paths(|| app_data.clone(), source_dsh_cli);

        assert!(paths.data_dir.starts_with(&app_data));
        assert!(paths.dsh_home.starts_with(&app_data));
        assert!(!paths.dsh_home.starts_with(user_home));
        assert!(paths.logs_dir.starts_with(&paths.data_dir));
        assert!(paths.runtime_dir.starts_with(&paths.data_dir));
        assert_eq!(paths.source_dsh_cli, PathBuf::from(source_dsh_cli));
    }
}
