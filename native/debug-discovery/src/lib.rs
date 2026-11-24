//! Network discovery for the debug link (ADR 0403 "Discovery"): a listening build advertises
//! `_myco-debug._tcp.local.` and a tool browses for those. The TXT record holds `name`, `platform`, `path` and the
//! protocol version `v`; never a token (being listed is not being trusted).
//!
//! `Discovery` owns one mDNS daemon. `record`, `choose_ipv4`, `build_from_service` and `instance_name` are the pure
//! parts: building a service's properties and turning a resolved service back into a [`Build`].
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};

/// The mDNS service type of a listening build.
pub const SERVICE_TYPE: &str = "_myco-debug._tcp.local.";
/// The TXT record's protocol version.
pub const PROTOCOL_VERSION: &str = "2";

/// A build found on the LAN.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Build {
    /// The mDNS instance's full name (stable while advertised).
    pub id: String,
    pub name: String,
    pub platform: String,
    /// `ws://<ipv4>:<port><path>`.
    pub address: String,
}

/// What a browser reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Found(Build),
    Lost { id: String },
}

pub type AdvertId = u32;
pub type BrowseId = u32;

/// The TXT properties of an advertised build.
pub fn record(name: &str, platform: &str, path: &str) -> Vec<(String, String)> {
    vec![
        ("name".into(), name.into()),
        ("platform".into(), platform.into()),
        ("path".into(), path.into()),
        ("v".into(), PROTOCOL_VERSION.into()),
    ]
}

/// The address to use among a service's addresses: a private IPv4 (10/8, 172.16/12, 192.168/16) first, then any other
/// IPv4 that isn't loopback, link-local or unspecified; none when there is no usable IPv4.
pub fn choose_ipv4(addresses: &[IpAddr]) -> Option<Ipv4Addr> {
    let v4: Vec<Ipv4Addr> = addresses
        .iter()
        .filter_map(|a| match a {
            IpAddr::V4(ip) => Some(*ip),
            IpAddr::V6(_) => None,
        })
        .collect();
    v4.iter()
        .copied()
        .find(|ip| ip.is_private())
        .or_else(|| v4.iter().copied().find(|ip| !ip.is_loopback() && !ip.is_link_local() && !ip.is_unspecified()))
}

/// A resolved service as a [`Build`]; None when it has no IPv4 address. A missing `name` falls back to the instance
/// name, a missing `platform` to "unknown", a missing `path` to "/".
pub fn build_from_service(fullname: &str, port: u16, addresses: &[IpAddr], txt: &dyn Fn(&str) -> Option<String>) -> Option<Build> {
    let ip = choose_ipv4(addresses)?;
    let instance = fullname.strip_suffix(SERVICE_TYPE).map(|s| s.trim_end_matches('.')).unwrap_or(fullname);
    let name = txt("name").filter(|s| !s.is_empty()).unwrap_or_else(|| instance.to_string());
    let platform = txt("platform").filter(|s| !s.is_empty()).unwrap_or_else(|| "unknown".into());
    let path = txt("path").filter(|s| s.starts_with('/')).unwrap_or_else(|| "/".into());
    Some(Build { id: fullname.to_string(), name, platform, address: format!("ws://{ip}:{port}{path}") })
}

/// The instance name: the display name (cut to mDNS's 63-byte label limit) and a suffix that is unique per process
/// (the process id and a counter).
pub fn instance_name(name: &str, counter: u32) -> String {
    let base: String = name.chars().filter(|c| !c.is_control() && *c != '.').collect();
    let base = base.trim();
    let base = if base.is_empty() { "Myco" } else { base };
    let suffix = format!("-{:x}{:x}", std::process::id(), counter);
    let mut cut = base.len().min(63 - suffix.len());
    while !base.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}{}", &base[..cut], suffix)
}

/// One mDNS daemon with the services this process advertises and the browsers it runs.
pub struct Discovery {
    daemon: ServiceDaemon,
    next: AtomicU32,
    adverts: Mutex<HashMap<AdvertId, String>>,
    browsers: Mutex<HashSet<BrowseId>>,
}

impl Discovery {
    pub fn new() -> Result<Discovery, String> {
        let daemon = ServiceDaemon::new().map_err(|e| format!("couldn't start mDNS: {e}"))?;
        Ok(Discovery { daemon, next: AtomicU32::new(0), adverts: Mutex::new(HashMap::new()), browsers: Mutex::new(HashSet::new()) })
    }

    /// Registers this host's service; its addresses are this host's IPv4 addresses, kept current.
    pub fn advertise(&self, name: &str, platform: &str, port: u16, path: &str) -> Result<AdvertId, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let instance = instance_name(name, id);
        let props = record(name, platform, path);
        let host = format!("{instance}.local.");
        let info = ServiceInfo::new(SERVICE_TYPE, &instance, &host, "", port, &props[..])
            .map_err(|e| format!("couldn't build the service: {e}"))?
            .enable_addr_auto();
        let fullname = info.get_fullname().to_string();
        self.daemon.register(info).map_err(|e| format!("couldn't advertise: {e}"))?;
        self.adverts.lock().unwrap().insert(id, fullname);
        Ok(id)
    }

    /// Withdraws an advert, waiting briefly for the daemon to send its goodbye: browsers drop the build at once, where a
    /// build that vanished without one stays listed until its PTR record expires (75 minutes in mdns-sd, not settable).
    pub fn unadvertise(&self, id: AdvertId) {
        if let Some(fullname) = self.adverts.lock().unwrap().remove(&id) {
            if let Ok(done) = self.daemon.unregister(&fullname) {
                let _ = done.recv_timeout(std::time::Duration::from_millis(500));
            }
        }
    }

    /// Browses until `browse_stop`; `callback` runs on a thread of its own for each build found or lost.
    pub fn browse(&self, callback: impl Fn(Event) + Send + 'static) -> Result<BrowseId, String> {
        let receiver = self.daemon.browse(SERVICE_TYPE).map_err(|e| format!("couldn't browse: {e}"))?;
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        self.browsers.lock().unwrap().insert(id);
        let seen: Arc<Mutex<HashSet<String>>> = Arc::default();
        std::thread::spawn(move || {
            // The loop ends when the daemon closes the channel (the last browser stopped, or the daemon's drop).
            while let Ok(event) = receiver.recv() {
                match event {
                    ServiceEvent::ServiceResolved(resolved) => {
                        let addresses: Vec<IpAddr> = resolved.get_addresses().iter().map(|a| a.to_ip_addr()).collect();
                        let build = build_from_service(resolved.get_fullname(), resolved.get_port(), &addresses, &|key| {
                            resolved.get_property_val_str(key).map(String::from)
                        });
                        if let Some(build) = build {
                            seen.lock().unwrap().insert(build.id.clone());
                            callback(Event::Found(build));
                        }
                    }
                    ServiceEvent::ServiceRemoved(_, fullname) => {
                        if seen.lock().unwrap().remove(&fullname) {
                            callback(Event::Lost { id: fullname });
                        }
                    }
                    _ => {}
                }
            }
        });
        Ok(id)
    }

    /// Stops a browser. Each browser has its own receiver, but the daemon stops browsing the service type for all
    /// of them, so the type is stopped only when the last browser goes.
    pub fn browse_stop(&self, id: BrowseId) {
        let mut browsers = self.browsers.lock().unwrap();
        if browsers.remove(&id) && browsers.is_empty() {
            let _ = self.daemon.stop_browse(SERVICE_TYPE);
        }
    }
}

impl Drop for Discovery {
    fn drop(&mut self) {
        for fullname in self.adverts.lock().unwrap().values() {
            let _ = self.daemon.unregister(fullname);
        }
        let _ = self.daemon.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    fn ip(a: u8, b: u8, c: u8, d: u8) -> IpAddr {
        IpAddr::V4(Ipv4Addr::new(a, b, c, d))
    }

    #[test]
    fn the_record_has_name_platform_path_and_version_and_no_token() {
        let r = record("Flappy", "desktop", "/myco-debug");
        assert_eq!(
            r,
            vec![
                ("name".to_string(), "Flappy".to_string()),
                ("platform".to_string(), "desktop".to_string()),
                ("path".to_string(), "/myco-debug".to_string()),
                ("v".to_string(), "2".to_string()),
            ]
        );
    }

    #[test]
    fn a_private_address_wins_over_a_public_one_and_ipv6_is_skipped() {
        let v6 = IpAddr::V6("fe80::1".parse().unwrap());
        assert_eq!(choose_ipv4(&[ip(8, 8, 4, 4), v6, ip(172, 20, 1, 2)]), Some(Ipv4Addr::new(172, 20, 1, 2)));
        assert_eq!(choose_ipv4(&[ip(11, 0, 0, 1), ip(10, 0, 0, 1)]), Some(Ipv4Addr::new(10, 0, 0, 1)));
        assert_eq!(choose_ipv4(&[ip(172, 32, 0, 1), ip(192, 168, 1, 5)]), Some(Ipv4Addr::new(192, 168, 1, 5)));
        assert_eq!(choose_ipv4(&[ip(8, 8, 4, 4)]), Some(Ipv4Addr::new(8, 8, 4, 4)));
    }

    #[test]
    fn no_ipv4_address_is_no_build() {
        let v6 = IpAddr::V6("fe80::1".parse().unwrap());
        assert_eq!(build_from_service("x._myco-debug._tcp.local.", 7790, &[v6], &|_| None), None);
        assert_eq!(build_from_service("x._myco-debug._tcp.local.", 7790, &[], &|_| None), None);
    }

    #[test]
    fn a_resolved_service_becomes_a_build_with_its_address() {
        let txt = |k: &str| match k {
            "name" => Some("Flappy".to_string()),
            "platform" => Some("desktop".to_string()),
            "path" => Some("/myco-debug".to_string()),
            _ => None,
        };
        let build = build_from_service("Flappy-1a2._myco-debug._tcp.local.", 7791, &[ip(192, 168, 1, 20)], &txt).unwrap();
        assert_eq!(build.id, "Flappy-1a2._myco-debug._tcp.local.");
        assert_eq!((build.name.as_str(), build.platform.as_str()), ("Flappy", "desktop"));
        assert_eq!(build.address, "ws://192.168.1.20:7791/myco-debug");
    }

    #[test]
    fn a_thin_record_falls_back_to_the_instance_name_and_root_path() {
        let build = build_from_service("Box-9._myco-debug._tcp.local.", 7790, &[ip(10, 0, 0, 2)], &|_| None).unwrap();
        assert_eq!((build.name.as_str(), build.platform.as_str()), ("Box-9", "unknown"));
        assert_eq!(build.address, "ws://10.0.0.2:7790/");
    }

    #[test]
    fn instance_names_differ_by_counter_stay_in_a_label_and_drop_dots() {
        assert_ne!(instance_name("Game", 1), instance_name("Game", 2));
        assert!(instance_name(&"é".repeat(100), 1).len() <= 63);
        assert!(!instance_name("a.b", 1).contains('.'));
        assert!(instance_name("", 1).starts_with("Myco-"));
    }

    // Needs this machine's multicast (a firewall or a VPN adapter can block it, and CI has none), so it is opt-in:
    // `cargo test -- --ignored`.
    #[test]
    #[ignore = "needs working multicast on this machine"]
    fn an_advertised_build_is_found_and_then_lost() {
        let discovery = Discovery::new().unwrap();
        let (tx, rx) = mpsc::channel();
        discovery
            .browse(move |e| {
                let _ = tx.send(e);
            })
            .unwrap();
        let advert = discovery.advertise("Discovery Test", "desktop", 7795, "/myco-debug").unwrap();
        let found = loop {
            match rx.recv_timeout(Duration::from_secs(20)).expect("no build found") {
                Event::Found(b) if b.name == "Discovery Test" => break b,
                _ => {}
            }
        };
        assert_eq!(found.platform, "desktop");
        assert!(found.address.ends_with(":7795/myco-debug"), "{}", found.address);
        discovery.unadvertise(advert);
        loop {
            match rx.recv_timeout(Duration::from_secs(20)).expect("no build lost") {
                Event::Lost { id } if id == found.id => break,
                _ => {}
            }
        }
    }
}
