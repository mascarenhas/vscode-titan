#!/usr/bin/env python3
"""Non-compiler cleanup fixture; the parent and descendant deliberately stay alive."""
import json
import os
import pathlib
import signal
import subprocess
import sys
import time

signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = subprocess.Popen([sys.executable, '-c',
    'import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)'])
marker = pathlib.Path(sys.argv[1])
temporary = marker.with_suffix('.tmp')
temporary.write_text(json.dumps({'pid': os.getpid(), 'child_pid': child.pid}))
temporary.replace(marker)
time.sleep(60)
