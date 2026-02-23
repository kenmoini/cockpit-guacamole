Name:           cockpit-guacamole
Version:        0.1.0
Release:        1%{?dist}
Summary:        Cockpit plugin for browser-based remote desktop access

License:        GPL-3.0-only
URL:            https://github.com/kenmoini/cockpit-rdp
Source0:        %{name}-%{version}.tar.gz
BuildArch:      noarch

Requires:       cockpit
Requires:       cockpit-bridge

%description
A Cockpit plugin that provides browser-based remote desktop access using
Apache Guacamole and xrdp. Connects to local or remote RDP sessions
directly through the Cockpit web interface without requiring a separate
Guacamole server or WebSocket proxy.

%prep
%setup -q

%build
# Assets are pre-built; nothing to compile

%install
mkdir -p %{buildroot}%{_datadir}/cockpit/%{name}
cp -rp . %{buildroot}%{_datadir}/cockpit/%{name}/

%files
%license LICENSE
%{_datadir}/cockpit/%{name}/

%changelog
* Sun Feb 22 2026 Ken Moini - 0.1.0-1
- Initial release of cockpit-guacamole
