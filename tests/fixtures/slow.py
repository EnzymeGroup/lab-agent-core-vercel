import os
import time
from pathlib import Path

Path(os.environ['AGENT_OUTPUT_DIR'], 'started.txt').write_text(str(os.getpid()))
time.sleep(60)
Path(os.environ['AGENT_OUTPUT_DIR'], 'should-not-exist.txt').write_text('cancellation failed')
