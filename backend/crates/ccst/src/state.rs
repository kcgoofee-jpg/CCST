//! 进程内共享状态：凭据缓存（避免每请求读盘）与强制刷新。

use ccst_auth::Credentials;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone, Default)]
pub struct SharedState {
    inner: Arc<RwLock<Option<Credentials>>>,
}

impl SharedState {
    pub fn new() -> Self {
        Self::default()
    }

    /// 取凭据：内存有就用（内存的总是最新刷新结果）；没有则读盘缓存。
    pub async fn credentials(&self) -> Option<Credentials> {
        if let Some(c) = self.inner.read().await.clone() {
            return Some(c);
        }
        let loaded = ccst_auth::load_credentials().ok();
        if let Some(c) = &loaded {
            *self.inner.write().await = Some(c.clone());
        }
        loaded
    }

    /// 强制刷新（上游 401）：走 auth 的 force_refresh 并更新内存。
    pub async fn force_refresh(&self) -> anyhow::Result<Credentials> {
        let fresh = ccst_auth::force_refresh().await?;
        *self.inner.write().await = Some(fresh.clone());
        Ok(fresh)
    }

    /// P1 简化版：确保凭据存在且未过期（过期则刷新），失败返回 None。
    pub async fn ensure_credentials(&self) -> Option<Credentials> {
        match self.credentials().await {
            Some(c) if !c.needs_refresh() => Some(c),
            other => {
                let refreshed = match &other {
                    Some(c) => ccst_auth::refresh(c.refresh_token.as_deref()?).await.ok(),
                    None => None,
                };
                match refreshed {
                    Some(resp) => {
                        let fallback = other.as_ref().and_then(|c| c.refresh_token.as_deref());
                        let fresh = ccst_auth::Credentials::from_response(&resp, fallback);
                        let _ = ccst_auth::save_credentials(&fresh);
                        *self.inner.write().await = Some(fresh.clone());
                        Some(fresh)
                    }
                    None => other,
                }
            }
        }
    }
}
