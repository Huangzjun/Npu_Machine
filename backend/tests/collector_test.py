import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "collector"))
from collect import parse_npu

ASCEND = """
| NPU ID | Name             | Health        | Power(W)              Temp(C)                  Hugepages-Usage(page) |
|        |                  | Bus-Id        | NPU Util(%)           Memory-Usage(MB)         HBM-Usage(MB)         |
| 0      | Ascend950DT      | OK            | 780.2                 67                       0     / 0             |
|        |                  | NA            | 100                   0     / 0                16299 / 98304         |
| 1      | Ascend950DT      | OK            | 404.1                 51                       0     / 0             |
|        |                  | NA            | 0                     0     / 0                4788  / 98304         |
| NPU ID                    | Process id    | Process name       | Process memory(MB)    | Process id in container |
| 0                         | 12            | first               | 200                   | NA                      |
| 0                         | 13            | second              | 100                   | NA                      |
| No running processes found in NPU 1                                                                             |
"""

class CollectorTests(unittest.TestCase):
    def test_950dt(self):
        first, second = parse_npu(ASCEND)
        self.assertEqual(first, {"id": 0, "health": "ok", "temperature": 67, "utilization": 100,
                                 "hbmUsed": 16299, "hbmTotal": 98304, "processes": 2})
        self.assertEqual(second["processes"], 0)
        self.assertEqual(second["utilization"], 0)

    def test_missing_process_table_is_unknown(self):
        self.assertIsNone(parse_npu(ASCEND.split("| NPU ID                    | Process")[0])[0]["processes"])

if __name__ == "__main__":
    unittest.main()
