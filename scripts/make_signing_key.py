#!/usr/bin/env python3
"""Generate the key pair that signs latest.json.

Prints the private key, which goes in this repo's RELEASE_SIGNING_PRIVATE_KEY
Actions secret, and the public numbers, which replace the placeholder in
vector's src/common/update.py (_release_public_key). Nothing is written to disk.
"""

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa


def main():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    numbers = key.public_key().public_numbers()

    print("Private key, for the RELEASE_SIGNING_PRIVATE_KEY secret:\n")
    print(pem)
    print("Public key, for vector's _release_public_key():\n")
    print(f"n={numbers.n},")
    print(f"e={numbers.e},")


if __name__ == "__main__":
    main()
