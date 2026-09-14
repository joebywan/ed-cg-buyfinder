#!/usr/bin/env python3
"""
The one place the version number lives.

It used to be a literal in four files - cgbuy, cg.py, verify.py and eddn.py -
and three of them had drifted to "2.0" while the app shipped as 1.5. That was
harmless while nothing read it; the startup update check reads it, and a
User-Agent that lies about its version is rude to the APIs besides. The
release workflow rewrites the line below and nothing else.
"""

VERSION = "1.7"

# What Spansh, EDSM and Frontier see. EDDN gets softwareName/softwareVersion
# as separate header fields instead - see eddn.py.
AGENT = "cgbuy/%s (personal ED trade helper)" % VERSION
