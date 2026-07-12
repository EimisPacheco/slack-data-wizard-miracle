"""Publish a .twbx to Tableau. Usage: publish.py <twbx> <workbook name>

The workbook embeds its data as a CSV inside the .twbx, so there is no live connection
and no credentials to attach.
"""
import os, sys
import tableauserverclient as TSC

twbx, name = sys.argv[1], sys.argv[2]
auth = TSC.PersonalAccessTokenAuth(os.environ["PAT_NAME"], os.environ["PAT_VALUE"], site_id=os.environ["SITE_NAME"])
server = TSC.Server(os.environ["SERVER"], use_server_version=True)

with server.auth.sign_in(auth):
    projects, _ = server.projects.get()
    proj = next((p for p in projects if p.name.lower() == "default"), projects[0])
    item = TSC.WorkbookItem(project_id=proj.id, name=name)
    wb = server.workbooks.publish(item, twbx, TSC.Server.PublishMode.Overwrite)
    print("PUBLISHED:", wb.id)
    server.workbooks.populate_views(wb)
    for v in wb.views:
        print(f"VIEW {v.name} {v.id}")
