Name:           cockpit-guacamole
Version:        0.1.0
Release:        1%{?dist}
Summary:        provii is a portable binary cli tool downloader

License:        GPLv3
URL:            https://github.com/kenmoini/cockpit-guacamole
Source:         %{name}-%{version}.tar.gz
BuildArch:      noarch

Requires:       cockpit, cockpit-bridge

%description
A Cockpit plugin that provides browser-based remote desktop access using Apache Guacamole and xrdp.

%prep
%setup -q

%install
rm -rf $RPM_BUILD_ROOT
mkdir -p $RPM_BUILD_ROOT/%{_bindir}
install %{name} $RPM_BUILD_ROOT/%{_bindir}
mkdir -p $RPM_BUILD_ROOT/%{_sysconfdir}
install %{name}rc $RPM_BUILD_ROOT/%{_sysconfdir}

%clean
rm -rf $RPM_BUILD_ROOT

%files
%{_bindir}/%{name}
%{_sysconfdir}/%{name}rc
%doc %{_mandir}/man1/%{name}.1.*
%license LICENSE

%changelog
* Sun Feb 22 2026 kenmoini
- Initial release of cockpit-guacamole