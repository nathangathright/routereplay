#!/usr/bin/env python3
"""Run exactly the tests shipped in the standalone skill distribution."""
from pathlib import Path
import sys
import unittest
from export_skill_repo import ROOT_FILES

ROOT=Path(__file__).resolve().parents[1]


def main():
    suite=unittest.TestSuite()
    paths=[ROOT/name for name in ROOT_FILES if name.startswith('tests/test_') and name.endswith('.py')]
    missing=[str(path.relative_to(ROOT)) for path in paths if not path.is_file()]
    if missing:
        print('Missing portable tests: '+', '.join(missing),file=sys.stderr)
        return 1
    for path in paths:
        suite.addTests(unittest.defaultTestLoader.discover(str(ROOT/'tests'),pattern=path.name))
    return 0 if unittest.TextTestRunner(verbosity=2).run(suite).wasSuccessful() else 1


if __name__=='__main__':
    raise SystemExit(main())
