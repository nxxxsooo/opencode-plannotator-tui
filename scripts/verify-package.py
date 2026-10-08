"""Compare published file bytes and executable bits, independent of tar/gzip encoding."""
import hashlib
import sys
import tarfile


def manifest(filename):
    result = {}
    with tarfile.open(filename, "r:gz") as archive:
        for member in archive:
            if member.isdir():
                continue
            if not member.isfile() or member.name in result:
                raise ValueError(f"Unsupported or duplicate package entry: {member.name}")
            result[member.name] = (
                member.mode & 0o111,
                hashlib.sha256(archive.extractfile(member).read()).hexdigest(),
            )
    return result


if __name__ == "__main__":
    try:
        expected, published = map(manifest, sys.argv[1:3])
        changed = [name for name in sorted(expected.keys() | published.keys())
                   if expected.get(name) != published.get(name)]
        if changed:
            raise ValueError("Package contents differ: " + ", ".join(changed))
        print(f"Verified {len(expected)} published files match source package contents.")
    except (ValueError, OSError, tarfile.TarError) as error:
        print(error, file=sys.stderr)
        sys.exit(1)
