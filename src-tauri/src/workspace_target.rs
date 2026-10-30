use serde::{Deserialize, Serialize};
use std::{fs, path::Path};
use tauri::Url;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum WorkspaceTarget {
    Local,
    Remote { url: String },
}

impl WorkspaceTarget {
    pub fn validate(self) -> Result<Self, String> {
        let Self::Remote { url } = self else {
            return Ok(self);
        };
        let parsed = Url::parse(url.trim()).map_err(|_| "Enter a valid server address.")?;
        let loopback = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if !(parsed.scheme() == "https" || parsed.scheme() == "http" && loopback)
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || parsed.path() != "/"
        {
            return Err("Use an HTTPS server address without a path, login, or query. HTTP is only available for this computer.".into());
        }
        Ok(Self::Remote {
            url: parsed.to_string(),
        })
    }
}

pub fn read(data: &Path) -> Result<WorkspaceTarget, String> {
    let path = data.join("workspace-target.json");
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(WorkspaceTarget::Local)
        }
        Err(_) => return Err("Could not read the selected workspace.".into()),
    };
    serde_json::from_str::<WorkspaceTarget>(&contents)
        .map_err(|_| "Could not read the selected workspace.".to_string())?
        .validate()
}

pub fn save(data: &Path, target: WorkspaceTarget) -> Result<(), String> {
    let target = target.validate()?;
    fs::create_dir_all(data).map_err(|_| "Could not save the workspace choice.")?;
    let bytes = serde_json::to_vec(&target).map_err(|_| "Could not save the workspace choice.")?;
    fs::write(data.join("workspace-target.json"), bytes)
        .map_err(|_| "Could not save the workspace choice.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn remote_workspace_requires_a_safe_address() {
        assert!(WorkspaceTarget::Remote {
            url: "https://server.tailnet.ts.net".into()
        }
        .validate()
        .is_ok());
        assert!(WorkspaceTarget::Remote {
            url: "http://127.0.0.1:1234".into()
        }
        .validate()
        .is_ok());
        for address in [
            "http://server.tailnet.ts.net",
            "https://user:secret@example.com",
            "https://example.com/?key=secret",
            "https://example.com/workspace",
        ] {
            assert!(WorkspaceTarget::Remote {
                url: address.into()
            }
            .validate()
            .is_err());
        }
    }

    #[test]
    fn workspace_choice_survives_restart_without_changing_the_local_workspace() {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let data = std::env::temp_dir().join(format!(
            "chat2tasks-workspace-choice-{}-{id}",
            std::process::id()
        ));
        let workspace = data.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("marker"), "local workspace").unwrap();
        assert_eq!(read(&data).unwrap(), WorkspaceTarget::Local);
        save(
            &data,
            WorkspaceTarget::Remote {
                url: "https://server.tailnet.ts.net".into(),
            },
        )
        .unwrap();
        assert_eq!(
            read(&data).unwrap(),
            WorkspaceTarget::Remote {
                url: "https://server.tailnet.ts.net/".into()
            }
        );
        assert_eq!(
            fs::read_to_string(workspace.join("marker")).unwrap(),
            "local workspace"
        );
        save(&data, WorkspaceTarget::Local).unwrap();
        assert_eq!(read(&data).unwrap(), WorkspaceTarget::Local);
        assert_eq!(
            fs::read_to_string(workspace.join("marker")).unwrap(),
            "local workspace"
        );
        fs::remove_dir_all(data).unwrap();
    }
}
