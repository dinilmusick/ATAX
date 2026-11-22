import unittest
from tools.execution.http_contract import ContractError, validate_contract, validate_endpoint, validate_payload

REGISTRY = {"email.send.v1": {"method": "POST", "endpoint": "https://mail.example.com/send",
 "target_ref": "mail-primary", "schema_version": "v1"}}

class HttpContractTests(unittest.TestCase):
    def test_registered_operation(self):
        self.assertEqual(validate_contract({"operation": "email.send.v1",
          "target_ref": "mail-primary", "schema_version": "v1"}, REGISTRY)["method"], "POST")

    def test_unknown_operation_rejected(self):
        with self.assertRaises(ContractError):
            validate_contract({"operation": "shell.run"}, REGISTRY)

    def test_target_mismatch_rejected(self):
        with self.assertRaises(ContractError):
            validate_contract({"operation": "email.send.v1", "target_ref": "other",
                               "schema_version": "v1"}, REGISTRY)

    def test_non_public_destinations_rejected(self):
        for url in ("http://example.com", "https://localhost", "https://127.0.0.1",
                    "https://10.0.0.1", "https://[::1]", "https://user:pass@example.com"):
            with self.subTest(url=url), self.assertRaises(ContractError):
                validate_endpoint(url)

    def test_invalid_endpoint_syntax(self):
        for url in ("https://[::1", "https://example.com:bad", "https://example.com:8443",
                    "https://localhost.", "https://example.com/?x=1", "https://example.com/#x",
                    "https://example.com\\n"):
            with self.subTest(url=url), self.assertRaises(ContractError):
                validate_endpoint(url)

    def test_agent_cannot_override_endpoint_or_credentials(self):
        for field in ("url", "endpoint", "headers", "credential", "secret", "method"):
            with self.subTest(field=field), self.assertRaises(ContractError):
                validate_contract({"operation": "email.send.v1", "target_ref": "mail-primary",
                                   "schema_version": "v1", field: "unsafe"}, REGISTRY)

    def test_payload_deterministic_and_bounded(self):
        a, ha = validate_payload({"b": 2, "a": 1})
        b, hb = validate_payload({"a": 1, "b": 2})
        self.assertEqual((a, ha), (b, hb))
        with self.assertRaises(ContractError):
            validate_payload({"body": "x" * 100}, max_bytes=16)

if __name__ == "__main__":
    unittest.main()
