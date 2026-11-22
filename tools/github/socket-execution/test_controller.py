import copy
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from contract import ContractError, ExecutionRequest, bounded_receipt
from controller import Controller, Github, Http, RemoteError, Supabase

ID = '11111111-1111-4111-8111-111111111111'
TASK = '22222222-2222-4222-8222-222222222222'
FENCE = '33333333-3333-4333-8333-333333333333'
CORR = '44444444-4444-4444-8444-444444444444'


def sample(**changes):
    doc = dict(id=ID,task_id=TASK,agent_id='worker-d',session_id='session-d',claim_fence=FENCE,
        correlation_id=CORR,idempotency_key='retry-key-00001',operation='test',
        target_repository='owner/repo',runner_repository='owner/repo',
        target_sha='a'*40,workflow_file='socket-target.yml',mode='target',
        input_payload={'suite':'fast'},expected_output={'category':'test-report'})
    doc.update(changes)
    return doc


class TestSupabaseQueryShapes(unittest.TestCase):
    def test_request_sorting_does_not_break_allowlist_lookup(self):
        class Capture(Http):
            def __init__(self): self.urls = []
            def request(self, method, url, token, payload=None, headers=None):
                self.urls.append(url)
                return 200, [{}]
        capture = Capture()
        db = Supabase('https://test.supabase.co', 'service-only-token', capture)
        db.rows('socket_dispatch_allowed_targets', {'enabled': 'true'})
        self.assertNotIn('order=created_at', capture.urls[0])
        db.rows('socket_dispatch_requests', {'status': 'in.(accepted,running)'})
        self.assertIn('order=created_at.asc', capture.urls[1])
        self.assertIn('status=in.%28accepted%2Crunning%29', capture.urls[1])


class FakeDB:
    def __init__(self, item=None, allowed=True, fence=True):
        self.item=item or sample()
        self.allowed=allowed
        self.fence=fence
        self.state='queued'
        self.calls=[]
        self.receipt=None

    def rows(self, table, filters):
        if table == 'socket_dispatch_allowed_targets':
            return [{}] if self.allowed else []
        if table == 'socket_dispatch_requests':
            if 'id' in filters and filters['id'] != self.item['id']:
                return []
            doc=copy.deepcopy(self.item)
            doc['status']=self.state
            return [doc]
        raise AssertionError(table)

    def rpc(self,name,args):
        self.calls.append((name,args))
        if name == 'socket_dispatch_begin':
            if not self.fence or self.state != 'queued':
                return False
            self.state='dispatching'
            return True
        if name == 'socket_dispatch_delivery_result':
            self.state=args['p_state']
            return True
        if name == 'socket_dispatch_finish_observed':
            self.state='succeeded' if args['p_conclusion']=='success' else 'failed'
            self.receipt=args['p_receipt']
            return True
        raise AssertionError(name)


class FakeGithub:
    def __init__(self):
        self.dispatches=0
        self.matches=[]
        self.cleanup_calls=0
        self.error=None
        self.cleanup_error=None

    def dispatch(self, req):
        self.dispatches+=1
        if self.error:
            raise RemoteError(self.error)

    def runs(self, req):
        return self.matches

    def delete_fmrl(self, req):
        self.cleanup_calls+=1
        if self.cleanup_error:
            raise RemoteError(self.cleanup_error)
        return 'independent_404'


def complete_run(conclusion='success'):
    return {'id': 12345,'status':'completed','conclusion':conclusion}


class TestContract(unittest.TestCase):
    def test_valid_fingerprint_deterministic(self):
        a=ExecutionRequest.from_record(sample())
        b=ExecutionRequest.from_record(sample(input_payload={'suite':'fast'}))
        self.assertEqual(a.fingerprint(), b.fingerprint())

    def test_revision_pin_mandatory(self):
        for revision in ('main','a'*39,'a'*41,'A'*40,'refs/heads/main'):
            with self.subTest(revision=revision), self.assertRaises(ContractError):
                ExecutionRequest.from_record(sample(target_sha=revision))

    def test_input_output_budgets_and_sensitive_inputs(self):
        for doc in (sample(input_payload={'blob':'a'*8192}),
                    sample(expected_output={'blob':'a'*2048}),
                    sample(input_payload={'api_token':'no'}),
                    sample(input_payload={'x':{'password':'no'}}),
                    sample(input_payload={'key':'ghp_example'})):
            with self.subTest(doc=str(doc)[:50]), self.assertRaises(ContractError):
                ExecutionRequest.from_record(doc)

    def test_no_unscoped_modes(self):
        for doc in (sample(mode='direct'), sample(operation='shell'),
                    sample(mode='target', runner_repository='owner/fmrl'),
                    sample(mode='fmrl', runner_repository='owner/repo'),
                    sample(workflow_file='../evil.yml')):
            with self.assertRaises(ContractError):
                ExecutionRequest.from_record(doc)

    def test_receipt_output_is_bounded_and_allowlisted(self):
        valid={'request_id':ID,'conclusion':'success','run_id':'12345','artifact_ref':'github-artifact://owner/repo/123/4'}
        self.assertEqual(bounded_receipt(valid), valid)
        for invalid in (dict(valid,stdout='raw secret'),dict(valid,artifact_ref='https://host/key'),
                        dict(valid,artifact_ref='github-artifact://'+'x'*400),
                        dict(valid,conclusion='debug')):
            with self.assertRaises(ContractError):
                bounded_receipt(invalid)


class TestRelay(unittest.TestCase):
    def test_duplicate_dispatch_protected_by_atomic_claim(self):
        db,gh=FakeDB(),FakeGithub(); c=Controller(db,gh)
        self.assertEqual(c.dispatch(ID,CORR),'relay_accepted')
        self.assertEqual(c.dispatch(ID,CORR),'already_started_or_fence_invalid')
        self.assertEqual(gh.dispatches,1)

    def test_lease_loss_denies_without_github_call(self):
        db,gh=FakeDB(fence=False),FakeGithub()
        self.assertEqual(Controller(db,gh).dispatch(ID,CORR),'already_started_or_fence_invalid')
        self.assertEqual(gh.dispatches,0)

    def test_deny_unapproved_target(self):
        db,gh=FakeDB(allowed=False),FakeGithub()
        with self.assertRaises(RemoteError): Controller(db,gh).dispatch(ID,CORR)
        self.assertEqual(gh.dispatches,0)

    def test_correlation_mismatch_denies(self):
        db,gh=FakeDB(),FakeGithub()
        with self.assertRaises(RemoteError): Controller(db,gh).dispatch(ID,TASK)
        self.assertEqual(gh.dispatches,0)

    def test_uncertain_delivery_not_replayed(self):
        db,gh=FakeDB(),FakeGithub(); gh.error='delivery_uncertain'
        with self.assertRaises(RemoteError): Controller(db,gh).dispatch(ID,CORR)
        self.assertEqual(db.state,'uncertain')
        self.assertEqual(Controller(db,gh).dispatch(ID,CORR),'already_started_or_fence_invalid')
        self.assertEqual(gh.dispatches,1)

    def test_terminal_failure_independently_observed(self):
        db,gh=FakeDB(),FakeGithub(); c=Controller(db,gh)
        c.dispatch(ID,CORR); gh.matches=[complete_run('failure')]
        self.assertEqual(c.reconcile()['terminal'],1)
        self.assertEqual(db.state,'failed')
        self.assertEqual(db.receipt['conclusion'],'failure')

    def test_missing_run_and_duplicate_run_do_not_claim_success(self):
        for matches in ([],[complete_run(),complete_run()]):
            db,gh=FakeDB(),FakeGithub(); c=Controller(db,gh)
            c.dispatch(ID,CORR); gh.matches=matches
            self.assertEqual(c.reconcile()['terminal'],0)
            self.assertEqual(db.state,'accepted')

    def test_fmrl_cleanup_and_independent_observation(self):
        fmrl='owner/atax-fmrl-'+CORR.replace('-','')[:20]
        db,gh=FakeDB(sample(mode='fmrl',runner_repository=fmrl)),FakeGithub()
        c=Controller(db,gh); c.dispatch(ID,CORR); gh.matches=[complete_run()]
        self.assertEqual(c.reconcile()['terminal'],1)
        self.assertEqual(gh.cleanup_calls,1)
        self.assertEqual(db.receipt['cleanup'],'independent_404')

    def test_cleanup_failure_blocks_terminal_certification(self):
        fmrl='owner/atax-fmrl-'+CORR.replace('-','')[:20]
        db,gh=FakeDB(sample(mode='fmrl',runner_repository=fmrl)),FakeGithub()
        c=Controller(db,gh); c.dispatch(ID,CORR); gh.matches=[complete_run()]
        gh.cleanup_error='fmrl_cleanup_not_verified'
        with self.assertRaises(RemoteError): c.reconcile()
        self.assertEqual(db.state,'accepted')

    def test_missing_credentials_fails_closed(self):
        with self.assertRaises(RemoteError): Supabase('https://project.supabase.co','',Http())
        with self.assertRaises(RemoteError): Github('',Http())

    def test_target_runner_workflow_does_not_receive_payload_or_secret(self):
        class Capture(Http):
            def __init__(self): self.messages=[]
            def request(self,method,url,token,payload=None,headers=None):
                self.messages.append((method,url,payload))
                return 204,None
        http=Capture(); Github('protected-secret',http).dispatch(ExecutionRequest.from_record(sample()))
        method,url,payload=http.messages[0]
        self.assertEqual(method,'POST')
        self.assertEqual(payload['ref'],'main')
        self.assertNotIn('input_payload',payload['inputs'])
        self.assertNotIn('protected-secret',str(payload))
        self.assertEqual(payload['inputs']['target_sha'],'a'*40)

    def test_delete_verified_independently_via_get(self):
        class Capture(Http):
            def __init__(self, confirm=404): self.calls=[];self.confirm=confirm
            def request(self,method,url,token,payload=None,headers=None):
                self.calls.append(method)
                return (204 if method=='DELETE' else self.confirm), None
        fmrl='owner/atax-fmrl-'+CORR.replace('-','')[:20]
        request=ExecutionRequest.from_record(sample(mode='fmrl',runner_repository=fmrl))
        yes=Capture(); self.assertEqual(Github('protected',yes).delete_fmrl(request),'independent_404')
        self.assertEqual(yes.calls,['DELETE','GET'])
        no=Capture(200)
        with self.assertRaises(RemoteError): Github('protected',no).delete_fmrl(request)

if __name__=='__main__': unittest.main()
